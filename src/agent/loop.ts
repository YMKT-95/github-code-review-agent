import type { Config } from '../config.js';
import { sanitiseText } from '../github/context.js';
import type { InitialContext } from '../github/context.js';
import { ContextRetrieval } from './retrieval.js';
import type { ReadSource } from './retrieval.js';
import type { LlmClient, Message, ModelTurn, ModelToolName } from '../llm/types.js';
import { ReviewError } from '../llm/types.js';
import { validateCandidate } from '../review/validator.js';
import { validateReviewResult } from '../review/schemas.js';
import { compareFindings } from '../review/ordering.js';
import { AgentState, patchEvidence } from './state.js';

export type AgentEvent = { event: 'turn' | 'tool' | 'final' | 'repair'; step: number; outcome: string };
const RESERVE = 4096;

// A local deadline also bounds injected clients; the signal cancels real SDK work.
async function modelTurn(client: LlmClient, messages: Message[], toolsEnabled: boolean, timeoutMs: number, availableTools: ModelToolName[]): Promise<ModelTurn> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([client.turn({ messages, toolsEnabled, availableTools }, controller.signal), new Promise<never>((_, reject) => {
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
  const retrieval = new ContextRetrieval(context, source, state, config, clean);
  const toolsEnabled = retrieval.tools.length > 0;
  const seed = structuredClone(context);
  const messages: Message[] = [{ role: 'user', content: '' }];
  const size = (extra: Message[] = [], enabled = toolsEnabled) => client.inputChars({ messages: [...messages, ...extra], toolsEnabled: enabled, availableTools: retrieval.tools });
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
  if (!source.canReadFiles) state.note('Repository file reads are unavailable from the connected MCP server.');
  if (context.files.length < context.metadata.changed_files || context.files.some((file) => !file.patch || file.patchTruncated)) {
    state.note('Initial diff coverage is partial; findings are limited to observed code.');
  }
  const callIds = new Set<string>();
  let final: unknown;
  let gotFinal = false;
  const invoke = async (toolsEnabled: boolean) => {
    if (size([], toolsEnabled) > config.MAX_CONTEXT_CHARS) throw new ReviewError('budget');
    const turn = await modelTurn(client, structuredClone(messages), toolsEnabled, Math.min(config.LLM_TIMEOUT_MS, 120000), retrieval.tools);
    state.requests++;
    state.usage.inputTokens += turn.usage.inputTokens;
    state.usage.outputTokens += turn.usage.outputTokens;
    return turn;
  };
  while (state.steps < config.MAX_AGENT_STEPS) {
    if (size() > config.MAX_CONTEXT_CHARS - RESERVE) { state.reason = 'context-limit'; break; }
    state.steps++;
    trace({ event: 'turn', step: state.steps, outcome: 'started' });
    const turn = await invoke(toolsEnabled);
    if (turn.kind === 'final') { final = turn.candidate; gotFinal = true; break; }
    const call = turn.call;
    if (!toolsEnabled || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || callIds.has(call.id) || JSON.stringify(call).length > 2048) throw new ReviewError('protocol');
    callIds.add(call.id);
    const response = { id: call.id, content: '', error: false };
    const pair: Message[] = [{ role: 'assistant', call }, { role: 'user', result: response }];
    // Reserve completion/repair capacity before fetching anything.
    const available = Math.min(config.MAX_TOOL_RESULT_CHARS, config.MAX_CONTEXT_CHARS - RESERVE - size(pair));
    if (available < 256) {
      response.content = 'Context budget reached. No file was read.'; response.error = true;
      if (size(pair) > config.MAX_CONTEXT_CHARS) throw new ReviewError('budget');
      messages.push(...pair); state.reason = 'context-limit'; break;
    }
    const observation = await retrieval.execute(call, available);
    response.content = observation.content; response.error = observation.error;
    if (size(pair) > config.MAX_CONTEXT_CHARS - RESERVE) {
      response.content = 'Context budget reached. Retrieved content was not supplied to the model.';
      response.error = true; state.reason = 'context-limit';
      state.note('Retrieved context could not fit the remaining model input budget.');
    } else if (observation.evidence) {
      state.observe(observation.evidence.path, observation.evidence.lines, observation.evidence.hasCode);
    }
    messages.push(...pair);
    const operation = retrieval.tools.find((name) => name === call.name) ?? 'unsupported-tool';
    trace({ event: 'tool', step: state.steps, outcome: `${operation}: ${response.error ? 'unavailable-or-denied' : 'observation-returned'}` });
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
  if (state.coverage().changedFilesInspected < context.metadata.changed_files) state.note('Not all changed files had code supplied to the model.');
  // Sanitise report prose again: a model can echo a secret from an observation.
  const findings = validated.findings.map((finding) => ({ ...finding, title: clean(finding.title), description: clean(finding.description), impact: clean(finding.impact), evidence: clean(finding.evidence), suggestion: clean(finding.suggestion) }))
    .sort(compareFindings).map((finding, index) => ({ ...finding, id: `F${index + 1}` }));
  const result = validateReviewResult({ summary: clean(validated.summary), findings, selection: validated.selection, coverage: state.coverage(), reviewedAt: new Date().toISOString() }, new Set(state.evidence.keys()));
  const selection = validated.selection;
  trace({ event: 'final', step: state.steps, outcome: `${selection.candidates} validated; ${selection.retained} retained; ${selection.lowConfidence} below confidence threshold; duplicates removed: ${selection.duplicates}` });
  return { result, state };
}
