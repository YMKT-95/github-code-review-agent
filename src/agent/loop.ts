import type { Config } from '../config.js';
import { sanitiseText } from '../github/context.js';
import type { InitialContext } from '../github/context.js';
import { changedFileRequestSchema } from '../github/tool-adapter.js';
import type { GitHubReadAdapter } from '../github/tool-adapter.js';
import type { LlmClient, Message, ModelTurn } from '../llm/types.js';
import { ReviewError } from '../llm/types.js';
import { validateCandidate } from '../review/validator.js';
import { validateReviewResult } from '../review/schemas.js';
import { AgentState, patchEvidence } from './state.js';

type ReadSource = Pick<GitHubReadAdapter, 'canReadFiles' | 'readChangedFile'>;
export type AgentEvent = { event: 'turn' | 'tool' | 'final' | 'repair'; step: number; outcome: string };
const RESERVE = 4096;

// A local deadline also bounds injected clients; the signal cancels real SDK work.
async function modelTurn(client: LlmClient, messages: Message[], toolsEnabled: boolean, timeoutMs: number): Promise<ModelTurn> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([client.turn({ messages, toolsEnabled }, controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ReviewError('timeout')); }, timeoutMs);
    })]);
  } catch (error) { throw error instanceof ReviewError ? error : new ReviewError('provider'); }
  finally { clearTimeout(timer); }
}

export async function runReview(context: InitialContext, source: ReadSource, client: LlmClient, config: Config,
  secrets: readonly string[] = [], trace: (event: AgentEvent) => void = () => {}) {
  if (!context.revisionStable) throw new ReviewError('revision');
  const state = new AgentState(context);
  const clean = (value: string) => sanitiseText(value, secrets);
  const seed = structuredClone(context);
  const messages: Message[] = [{ role: 'user', content: '' }];
  const size = (extra: Message[] = [], toolsEnabled = source.canReadFiles) => client.inputChars({ messages: [...messages, ...extra], toolsEnabled });
  const seedMessage = () => { messages[0] = { role: 'user', content: clean(JSON.stringify({ observation: 'Untrusted PR context', metadata: seed.metadata, files: seed.files, status: seed.status, limitations: seed.limitations })) }; };
  seedMessage();
  // Leave room for observations. Remove whole patches, never broken JSON or hunks.
  for (let index = seed.files.length - 1; size() > config.MAX_CONTEXT_CHARS * 0.6 && index >= 0; index--) {
    if (seed.files[index]!.patch) {
      delete seed.files[index]!.patch;
      seed.files[index]!.patchTruncated = true;
      state.note('Some initial patches were omitted to reserve model context capacity.');
      seedMessage();
    }
  }
  if (size() > config.MAX_CONTEXT_CHARS - RESERVE) throw new ReviewError('budget');
  for (const file of seed.files) {
    if (file.patch) {
      const observed = patchEvidence(clean(file.patch));
      state.observe(file.filename, observed.lines, observed.hasCode);
    }
  }
  if (!source.canReadFiles) state.note('Changed-file reads are unavailable from the connected MCP server.');
  if (context.files.length < context.metadata.changed_files || context.files.some((file) => !file.patch || file.patchTruncated)) {
    state.note('Initial diff coverage is partial; findings are limited to observed code.');
  }
  const callIds = new Set<string>();
  let final: unknown;
  let gotFinal = false;
  const invoke = async (toolsEnabled: boolean) => {
    if (size([], toolsEnabled) > config.MAX_CONTEXT_CHARS) throw new ReviewError('budget');
    const turn = await modelTurn(client, structuredClone(messages), toolsEnabled, Math.min(config.LLM_TIMEOUT_MS, 120000));
    state.requests++;
    state.usage.inputTokens += turn.usage.inputTokens;
    state.usage.outputTokens += turn.usage.outputTokens;
    return turn;
  };
  while (state.steps < config.MAX_AGENT_STEPS) {
    if (size() > config.MAX_CONTEXT_CHARS - RESERVE) { state.reason = 'context-limit'; break; }
    state.steps++;
    trace({ event: 'turn', step: state.steps, outcome: 'started' });
    const turn = await invoke(source.canReadFiles);
    if (turn.kind === 'final') { final = turn.candidate; gotFinal = true; break; }
    const call = turn.call;
    if (!source.canReadFiles || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || callIds.has(call.id) || JSON.stringify(call).length > 2048) throw new ReviewError('protocol');
    callIds.add(call.id);
    const parsed = changedFileRequestSchema.safeParse(call.input);
    const response = { id: call.id, content: '', error: false };
    const pair: Message[] = [{ role: 'assistant', call }, { role: 'user', result: response }];
    // Reserve completion/repair capacity before fetching anything.
    const available = Math.min(config.MAX_TOOL_RESULT_CHARS, config.MAX_CONTEXT_CHARS - RESERVE - size(pair));
    if (available < 256) {
      response.content = 'Context budget reached. No file was read.'; response.error = true;
      if (size(pair) > config.MAX_CONTEXT_CHARS) throw new ReviewError('budget');
      messages.push(...pair); state.reason = 'context-limit'; break;
    }
    if (call.name !== 'read_changed_file' || !parsed.success || !context.files.some((file) => file.filename === parsed.data.path)) {
      response.content = 'Tool denied. Use read_changed_file with only path and revision (head or base).'; response.error = true;
      state.note('An unsupported tool request was denied.');
    } else {
      const { path, revision } = parsed.data;
      const key = JSON.stringify([context.metadata[revision].repo?.full_name, context.metadata[revision].sha, path]);
      if (state.visited.has(key)) {
        response.content = 'This resource was already requested. Reuse its earlier observation; no additional read occurred.';
      } else if (!state.evidence.has(path) && state.evidence.size >= config.MAX_FILES_TO_INSPECT) {
        response.content = 'File inspection budget reached.'; response.error = true;
        state.note('File inspection budget reached.'); state.reason = 'context-limit';
      } else {
        state.visited.add(key);
        try {
          state.toolCalls++;
          const text = clean(await source.readChangedFile(parsed.data, context));
          // Keep only complete numbered lines so line validation never approves a cut line.
          const allLines = text.split('\n');
          if (allLines.at(-1) === '') allLines.pop();
          const lines: { line: number; text: string }[] = [];
          for (let index = 0; index < allLines.length; index++) {
            const item = { line: index + 1, text: allLines[index]! };
            const test = JSON.stringify({ path, revision, lines: [...lines, item], truncated: true });
            // Account for JSON escaping when this string enters the SDK body.
            if (JSON.stringify(test).length > available || test.length > config.MAX_PATCH_CHARS) break;
            lines.push(item);
          }
          const truncated = lines.length < allLines.length;
          response.content = JSON.stringify({ path, revision, lines, truncated });
          if (truncated) state.note('Some requested file content was truncated; only complete delivered lines count as evidence.');
          if (size(pair) > config.MAX_CONTEXT_CHARS - RESERVE) {
            response.content = 'Context budget reached. Retrieved content was not supplied to the model.'; response.error = true; state.reason = 'context-limit';
          } else {
            state.observe(path, revision === 'head' ? lines.map((item) => item.line) : [], lines.length > 0);
          }
        } catch {
          response.content = 'File read unavailable or denied. Do not infer a defect from missing context.'; response.error = true;
          state.note('At least one requested file could not be read.');
          if (state.reason === 'sufficient-evidence') state.reason = 'tool-failure';
        }
      }
    }
    messages.push(...pair);
    trace({ event: 'tool', step: state.steps, outcome: response.error ? 'unavailable-or-denied' : 'observation-returned' });
    if (state.reason === 'context-limit') break;
  }
  if (!gotFinal) {
    if (state.reason !== 'context-limit') state.reason = 'step-limit';
    state.note(`Review ended at the ${state.reason}; additional retrieval was disabled.`);
    messages.push({ role: 'user', content: 'Retrieval has ended. Return the best supported final JSON review now using only observations already supplied. Omit speculative findings.' });
    const turn = await invoke(false);
    if (turn.kind !== 'final') throw new ReviewError('protocol');
    final = turn.candidate;
  }
  let validated = validateCandidate(final, state.evidence, config.MIN_FINDING_CONFIDENCE);
  if (!validated.ok) {
    trace({ event: 'repair', step: state.steps, outcome: 'one-attempt' });
    messages.push({ role: 'user', content: `Your final output did not pass validation. ${validated.issues} Return corrected JSON using existing evidence only; no tool calls.` });
    const repaired = await invoke(false);
    if (repaired.kind !== 'final') throw new ReviewError('invalid-output');
    validated = validateCandidate(repaired.candidate, state.evidence, config.MIN_FINDING_CONFIDENCE);
    if (!validated.ok) throw new ReviewError('invalid-output');
  }
  if (state.evidence.size < context.metadata.changed_files) state.note('Not all changed files had code supplied to the model.');
  // Sanitise report prose again: a model can echo a secret from an observation.
  const findings = validated.findings.map((finding) => ({ ...finding, title: clean(finding.title), description: clean(finding.description), impact: clean(finding.impact), evidence: clean(finding.evidence), suggestion: clean(finding.suggestion) }));
  const result = validateReviewResult({ summary: clean(validated.summary), findings, coverage: state.coverage(), reviewedAt: new Date().toISOString() }, new Set(state.evidence.keys()));
  trace({ event: 'final', step: state.steps, outcome: `${findings.length} retained; ${validated.rejected} filtered` });
  return { result, state };
}
