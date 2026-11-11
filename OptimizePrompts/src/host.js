/**
 * dsh-optimize-prompts — Host half.
 *
 * Owns:
 *
 *   1. the durable settings document (model, reasoning effort, instruction,
 *      reference preferences, image preference) under
 *      `$DSH_HOME/optimize-prompts.json`;
 *   2. the same-origin browser routes the client half talks to;
 *   3. the model call, through the live `llm` service, so the plugin reuses the
 *      deployment's providers, credentials, and adapters;
 *   4. reference validation: the model may nominate paths and skill names, but
 *      only entries confirmed by the live file index and skill catalog reach the
 *      composer.
 *
 * `llm` and `webServer` are resolved lazily: a composition without either still
 * loads, and the routes report "unavailable" instead of failing the whole row.
 * No shipped DSH behavior is patched.
 *
 * @module dsh-optimize-prompts
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/* Also the Loader row id in cordis.patch.yml. */
const name = PACKAGE_NAME;

/* DSH Cordis treats every inject key as a required service. Web routes are
   registered through ctx.inject below, and `llm` is read at call time. */
const inject = [];

/* ------------------------------------------------------------------- storage */

/** One JSON document per DSH home, beside the other user-level state. */
function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'optimize-prompts.json');
}

/** Read the durable settings, falling back to defaults for a missing/broken file. */
async function readState() {
  try {
    const raw = await readFile(statePath(), 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch {
    /* Missing, empty, or corrupt simply means "still at defaults". */
    return normalizeState({});
  }
}

/** Persist the settings atomically; a failure is reported, never swallowed. */
async function saveState(state) {
  const target = statePath();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return state;
}

/* -------------------------------------------------------------- HTTP helpers */

/** Build an error carrying the HTTP status the route should answer with. */
function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Read a raw request body with a hard size cap.
 *
 * Oversized bodies are drained and then rejected with a 413 instead of
 * destroying the socket. Destroying first would turn a readable "too large"
 * error into `ECONNRESET` on the browser side.
 *
 * @param req - incoming HTTP request.
 * @returns the decoded UTF-8 body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(httpError(`request body exceeds ${MAX_BODY_BYTES} bytes`, 413));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Read and parse a JSON object body. */
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError('request body must be valid JSON', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError('request body must be a JSON object', 400);
  }
  return parsed;
}

/* ---------------------------------------------------------------- model call */

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Validate the images array a browser may send.
 *
 * A refused entry fails the whole request: silently dropping one of two images
 * would make the rewrite reason about a picture the user thought it had.
 *
 * @param value - raw `images` field from the request body.
 * @returns `{ mediaType, data, name? }` entries, possibly empty.
 * @throws a 400/413 error when the batch is malformed or too large.
 */
function readRequestImages(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError('images must be an array', 400);
  if (value.length > MAX_REQUEST_IMAGES) {
    throw httpError(`at most ${MAX_REQUEST_IMAGES} images may be optimized at once`, 400);
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw httpError(`images[${index}] must be an object`, 400);
    }
    const mediaType = entry.mediaType;
    if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw httpError(`images[${index}].mediaType must be one of ${[...IMAGE_MEDIA_TYPES].join(', ')}`, 400);
    }
    const data = entry.data;
    if (typeof data !== 'string' || data === '') {
      throw httpError(`images[${index}].data must be a base64 string`, 400);
    }
    if (data.length > MAX_REQUEST_IMAGE_CHARS) {
      throw httpError(`images[${index}] is larger than the ${MAX_REQUEST_IMAGE_CHARS} character limit`, 413);
    }
    const imageName = typeof entry.name === 'string' && entry.name !== ''
      ? entry.name.slice(0, 200)
      : undefined;
    return { mediaType, data, ...(imageName === undefined ? {} : { name: imageName }) };
  });
}

/** Wrap one string as the text-only user turn. */
function textContent(text) {
  return [{ type: 'text', text }];
}

/**
 * Resolve the model route for one rewrite.
 *
 * A configured provider/model pair wins, but only while the provider still
 * exists and the model is still advertised by it. The settings page mirrors this
 * priority. When the stored pair is gone, the plugin's vision-capable default is
 * tried, then the deployment default.
 *
 * @param llm - live LLM service.
 * @param defaults - `agentDefaultModel` service, when present.
 * @param state - current settings document.
 * @returns `{ provider, model, reasoningEffort? }`.
 * @throws when no routable model can be determined.
 */
async function resolveRoute(llm, defaults, state) {
  const providers = llm.listProviders().map((provider) => provider.id);
  /* A provider may expose an empty model list when it has no static catalog.
     Treat that as "cannot disprove" rather than breaking a working setup. */
  const modelAvailable = async (provider, model) => {
    try {
      const models = await llm.listModels(provider);
      return models.length === 0 || models.some((entry) => entry.id === model);
    } catch {
      return true;
    }
  };
  const effort = state.reasoningEffort === '' ? {} : { reasoningEffort: state.reasoningEffort };
  if (state.provider !== '' && state.model !== '' && providers.includes(state.provider)
    && await modelAvailable(state.provider, state.model)) {
    return { provider: state.provider, model: state.model, ...effort };
  }
  if (providers.includes(PREFERRED_PROVIDER) && await modelAvailable(PREFERRED_PROVIDER, PREFERRED_MODEL)) {
    return { provider: PREFERRED_PROVIDER, model: PREFERRED_MODEL, ...effort };
  }
  const fallback = defaults?.currentSelection();
  if (fallback === undefined || fallback === null) {
    throw httpError('no model is configured: set a deployment default model, or choose one in the plugin settings', 400);
  }
  return { provider: fallback.provider, model: fallback.model, ...effort };
}

/**
 * Compose the user turn, admitting the draft's images as model context.
 *
 * Every refusal degrades to a text-only rewrite with a status the client can
 * explain, rather than failing the whole click.
 *
 * @param hostCtx - host context carrying the optional attachments service.
 * @param llm - live LLM service.
 * @param route - resolved provider and model.
 * @param images - validated image entries.
 * @param text - instruction that follows the images in the same turn.
 * @returns `{ content, status, error? }`.
 */
async function composeUserContent(hostCtx, llm, route, images, text) {
  const attachments = hostCtx.get('attachments');
  if (attachments === undefined) {
    return { content: textContent(text), status: 'no-store' };
  }
  /* A text-only model must not receive image blocks. Asking first also gives the
     user a truthful explanation instead of a provider-side projection. */
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model);
    if (info?.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      return { content: textContent(text), status: 'text-only' };
    }
  } catch {
    /* An unknown model still gets a chance; admission below is the real gate. */
  }
  try {
    const content = await attachments.admitPromptContent([
      ...images.map((image) => ({
        type: 'image',
        mediaType: image.mediaType,
        data: image.data,
        ...(image.name === undefined ? {} : { name: image.name }),
      })),
      { type: 'text', text },
    ]);
    return { content, status: 'sent' };
  } catch (error) {
    return {
      content: textContent(text),
      status: 'failed',
      error: String(error?.message ?? error),
    };
  }
}

/** Map one stream finish outcome onto a human-readable failure, if any. */
function finishFailure(finish) {
  if (finish === undefined || finish === null) return 'the model stream ended without a finish event';
  switch (finish.kind) {
    case 'stop':
      return null;
    case 'length':
    case 'max-tokens':
      return 'the model hit the output token limit before finishing the prompt';
    case 'tool-calls':
      return 'the model attempted a tool call instead of returning prompt text';
    case 'content-filter':
      return 'the provider refused the request';
    case 'aborted':
      return 'the optimization was aborted';
    case 'error':
      return finish.failure?.message ?? 'the provider call failed';
    default:
      return `unsupported finish reason "${String(finish.kind)}"`;
  }
}

/**
 * Accumulate the visible text of one chunk stream.
 *
 * Reasoning blocks are excluded on purpose; only answer text reaches the draft.
 */
function accumulateText() {
  const fragments = new Map();
  let finish;
  let toolCall = false;
  return {
    push(chunk) {
      if (chunk.type === 'text-delta') {
        fragments.set(chunk.index, (fragments.get(chunk.index) ?? '') + chunk.text);
        return;
      }
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
        toolCall = true;
        return;
      }
      if (chunk.type === 'finish') finish = chunk.reason;
    },
    text() {
      return [...fragments.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, text]) => text)
        .join('\n')
        .trim();
    },
    reason() {
      return finish;
    },
    openedToolCall() {
      return toolCall;
    },
  };
}

/**
 * Run one model call and return its assistant text.
 *
 * @param llm - live LLM service.
 * @param route - provider, model, optional reasoning effort.
 * @param system - system instruction for this call.
 * @param content - user-role content blocks, in message order.
 * @param signal - cancellation deadline; defaults to the full request timeout.
 * @returns the streamed answer text.
 * @throws when the call fails, is aborted, or ends without a usable finish.
 */
async function callModel(llm, route, system, content, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) {
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content }],
    system,
    maxTokens: MAX_OUTPUT_TOKENS,
    purpose: 'optimize-prompts',
    signal,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  };
  const assembler = accumulateText();
  for await (const chunk of llm.stream(options)) assembler.push(chunk);
  const failure = finishFailure(assembler.reason());
  if (failure !== null) throw new Error(failure);
  if (assembler.openedToolCall()) {
    throw new Error('the model returned a tool call instead of prompt text');
  }
  return assembler.text();
}

/* ------------------------------------------------------------------ references */

/** Normalize one model-nominated path into the shape the file index speaks. */
function normalizeQuery(value) {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^@/u, '')
    .replace(/^"+|"+$/gu, '')
    .replace(/^\.\/+/u, '');
}

/**
 * Decide whether one index candidate answers a nomination.
 *
 * A fragment must land on a segment boundary: `host` matches `src/host.js`,
 * while `ost` matches nothing. Mid-segment matches are refused on purpose,
 * because they are how one nomination would silently resolve to an unrelated
 * file in a deep tree.
 *
 * @param path - candidate path from the index.
 * @param query - normalized nomination.
 * @returns whether the candidate answers it.
 */
function nominationMatches(path, query) {
  if (query === '') return false;
  if (path === query) return true;
  /* A filename with an extension is a complete name, never a prefix of a backup. */
  const completeName = /\.[^/]+$/u.test(query);
  if (completeName && query.includes('/')) return false;
  let offset = path.indexOf(query);
  while (offset !== -1) {
    const next = path[offset + query.length];
    if ((offset === 0 || path[offset - 1] === '/')
      && (next === undefined || next === '/' || (!completeName && next === '.'))) return true;
    offset = path.indexOf(query, offset + 1);
  }
  return false;
}

/** Bound even providers that ignore cancellation, without leaving abort listeners. */
async function withSignal(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Build the workspace path listing the candidate question shows.
 *
 * The reference index answers a bare query with one directory's entries, so the
 * overview is a breadth-first walk of its first levels: directories expand until
 * the budget runs out, which keeps a large tree from flooding the question while
 * prioritizing explicit task paths and sharing capacity across top-level areas.
 *
 * @param service - the file-reference service.
 * @param agent - live agent whose working directory bounds discovery.
 * @param signal - cancellation for the listings.
 * @param prompt - draft used to prioritize matching paths.
 * @param notes - accumulator for partial-discovery explanations.
 * @returns workspace-relative paths, breadth-first, capped by the budget.
 */
async function listWorkspacePaths(service, agent, signal, prompt = '', notes = []) {
  const paths = [];
  const seen = new Set();
  const visited = new Set();
  const budget = CANDIDATE_PATH_BUDGET;
  const terms = prompt.toLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) ?? [];
  const score = (path) => terms.reduce((sum, term) => sum + (path.toLowerCase().includes(term) ? term.length : 0), 0);
  let successfulQueries = 0;
  const list = async (query) => {
    try {
      const entries = await withSignal(() => service.list(agent, query, signal), signal);
      successfulQueries++;
      return [...entries];
    } catch {
      return [];
    }
  };
  const collect = (entry) => {
    if (seen.has(entry.path) || paths.length >= budget) return;
    seen.add(entry.path);
    paths.push(entry.kind === 'directory' ? `${entry.path.replace(/\/+$/u, '')}/` : entry.path);
  };
  /* Task paths get first use of the budget, including nonconventional directories. */
  const explicit = lostOriginalPaths('', prompt, []);
  for (const path of explicit.slice(0, 8)) {
    if (signal.aborted) break;
    const entries = await list(path.replace(/\/+$/u, ''));
    for (const entry of entries.filter((candidate) => nominationMatches(candidate.path, path.replace(/\/+$/u, '')))) collect(entry);
  }
  /* Root listing is optional: older providers may reject it or return nothing. */
  const rootEntries = signal.aborted ? [] : await list('');
  const roots = rootEntries.filter((entry) => entry.kind === 'directory').map((entry) => `${entry.path}/`);
  const taskRoots = explicit.filter((path) => path.includes('/')).map((path) => `${path.split('/')[0]}/`);
  let queue = [...new Set([...taskRoots, ...(roots.length > 0 ? roots : CANDIDATE_DIRECTORY_HINTS.map((hint) => `${hint}/`))])];
  let batches = [rootEntries];
  let calls = 0;
  /* Round-robin collections prevent the first large directory consuming the budget. */
  while (!signal.aborted && paths.length < budget) {
    if (queue.length > 0 && calls < 80) {
      const current = queue.splice(0, 6).filter((directory) => !visited.has(directory));
      current.forEach((directory) => visited.add(directory));
      calls += current.length;
      batches.push(...await Promise.all(current.map(list)));
    }
    batches = batches.map((entries) => entries.sort((a, b) => score(b.path) - score(a.path)));
    /* Keep some capacity for later top-level areas and deeper files. */
    for (let round = 0; round < 8 && paths.length < budget; round++) {
      for (const entries of batches) {
        const entry = entries.shift();
        if (!entry) continue;
        collect(entry);
        if (entry.kind === 'directory' && entry.path.split('/').filter(Boolean).length < 4) {
          const directory = `${entry.path.replace(/\/+$/u, '')}/`;
          if (!visited.has(directory) && !queue.includes(directory)) queue.push(directory);
        }
      }
    }
    batches = batches.filter((entries) => entries.length > 0);
    if ((queue.length === 0 || calls >= 80) && batches.length === 0) break;
  }
  if (signal.aborted) notes.push('workspace discovery timed out; only a partial candidate list was available');
  else if (successfulQueries === 0) notes.push('workspace discovery unavailable: all index queries failed');
  return paths;
}

/**
 * Resolve model-nominated paths against the live file index.
 *
 * The model's own token never reaches the composer: a nomination survives only
 * when the index answers it, and an exact path beats a partial one. Ambiguous
 * fragments are refused rather than guessed.
 *
 * @param hostCtx - host context carrying the optional file-reference service.
 * @param agent - live agent whose working directory bounds discovery.
 * @param nominations - model-proposed paths or path fragments.
 * @param signal - cancellation for the lookups.
 * @param notes - accumulator for ambiguous or failed lookups.
 * @returns validated `{ path, kind, token }` entries, most relevant first.
 */
async function resolveFileReferences(hostCtx, agent, nominations, signal, notes = []) {
  const service = hostCtx.get('fileReferences');
  if (service === undefined || agent === undefined) {
    throw new Error('file references are unavailable: this composition has no file-reference index for the session');
  }
  const resolved = [];
  const seen = new Set();
  /* The lookups are independent, and a cold index pays its traversal once and
     shares it: resolving them together keeps five nominations from costing five
     serial waits. Order is restored below, so the model's ranking survives. */
  const looked = await Promise.all(nominations.slice(0, MAX_FILE_NOMINATIONS).map(async (nomination) => {
    const query = normalizeQuery(nomination);
    if (query === '') return undefined;
    let candidates;
    try {
      const directory = query.endsWith('/');
      const stem = query.replace(/\/+$/u, '');
      const parent = stem.includes('/') ? `${stem.slice(0, stem.lastIndexOf('/'))}/` : '';
      candidates = await withSignal(() => service.list(agent, directory ? parent : query, signal), signal);
      if (directory) {
        candidates = candidates.filter((entry) => entry.kind === 'directory' && entry.path === stem);
        if (candidates.length === 0) {
          const exact = await withSignal(() => service.list(agent, stem, signal), signal);
          candidates = exact.filter((entry) => entry.kind === 'directory' && entry.path === stem);
        }
      }
    } catch (error) {
      notes.push(`file lookup failed: ${String(error?.message ?? error)}`);
      return undefined;
    }
    const stem = query.replace(/\/+$/u, '');
    const matches = candidates.filter((candidate) => nominationMatches(candidate.path, stem));
    /* Exact paths win; ambiguous fragments are refused instead of guessing. */
    const exact = matches.find((candidate) => candidate.path === stem);
    const unique = [...new Map(matches.map((candidate) => [candidate.path, candidate])).values()];
    const chosen = exact ?? (unique.length === 1 ? unique[0] : undefined);
    if (chosen === undefined) {
      if (unique.length > 1) notes.push(`ambiguous file nomination: ${query}`);
      return undefined;
    }
    const token = formatFileMention(chosen.path, chosen.kind);
    if (token === undefined) return undefined;
    return { path: chosen.path, kind: chosen.kind, token };
  }));
  for (const entry of looked) {
    if (entry === undefined || seen.has(entry.token)) continue;
    seen.add(entry.token);
    resolved.push(entry);
  }
  return resolved;
}

/**
 * Resolve model-nominated skill names against the live skill catalog.
 *
 * Names are matched exactly against the layers this exact agent sees, and only
 * skills that are both model- and user-invocable survive: the block tells the
 * agent to load the skill through its `skill` tool, and DSH only honours a
 * `/name` gesture for a user-invocable skill.
 *
 * @param hostCtx - host context carrying the optional skills service.
 * @param agent - live agent whose scope and working directory select the layers.
 * @param cwd - the Session's working directory, when known.
 * @param nominations - model-proposed skill names.
 * @param skillMode - the skill tier; eager keeps every nomination.
 * @param signal - cancellation for discovery.
 * @returns validated `{ name, description }` entries, catalog order.
 */
async function resolveSkillReferences(hostCtx, agent, cwd, nominations, skillMode, signal) {
  if (agent === undefined) {
    throw new Error('skill references are unavailable: this composition has no live agent for the session');
  }
  const service = hostCtx.get('skills');
  if (service === undefined) {
    throw new Error('skill references are unavailable: this composition has no skill catalog');
  }
  const catalog = await withSignal(() => service.list({ scope: agent, ...(cwd === undefined ? {} : { cwd }), signal }), signal);
  const wanted = new Set(nominations.slice(0, skillNominationLimit(skillMode)).map((value) => value.trim()));
  return catalog
    .filter((skill) => wanted.has(skill.name)
      && skill.invocation?.modelInvocable === true
      && skill.invocation?.userInvocable === true)
    .map((skill) => ({ name: skill.name, description: skill.description }));
}

/**
 * List the skills this agent can load, as candidates for the nomination question.
 *
 * A model has no way to read the catalog itself; asked to name skills unaided,
 * it correctly answers "none" rather than guess. Listing them turns the question
 * into a choice.
 *
 * @param hostCtx - host context carrying the optional skills service.
 * @param agent - live agent whose scope and working directory select the layers.
 * @param cwd - the Session's working directory, when known.
 * @param signal - cancellation for discovery.
 * @returns `name — description` lines, catalog order, capped by the budget.
 */
async function listAvailableSkills(hostCtx, agent, cwd, signal) {
  const service = hostCtx.get('skills');
  if (service === undefined || agent === undefined) return [];
  try {
    const catalog = await withSignal(() => service.list({ scope: agent, ...(cwd === undefined ? {} : { cwd }), signal }), signal);
    return catalog
      .filter((skill) => skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true)
      .slice(0, CANDIDATE_SKILL_BUDGET)
      .map((skill) => (typeof skill.description === 'string' && skill.description !== ''
        ? `${skill.name} — ${skill.description}`
        : skill.name));
  } catch {
    /* A catalog that cannot be read simply leaves the question without skills. */
    return [];
  }
}

/** Transform only prose regions, keeping fenced examples intact. */
function outsideFences(prompt, transform) {
  let fence = null;
  let buffer = '';
  let result = '';
  for (const line of prompt.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const delimiter = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter && fence === null) {
      result += transform(buffer);
      buffer = '';
      fence = delimiter;
      result += line;
    } else if (fence !== null) {
      result += line;
      if (delimiter && delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
    } else {
      buffer += line;
    }
  }
  return result + transform(buffer);
}

/** Read mention paths outside fenced code; quoted directory mentions end at EOL. */
function existingFileMentions(prompt) {
  const paths = new Set();
  outsideFences(prompt, (prose) => {
    for (const line of prose.split('\n')) {
      for (const match of line.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|"([^"\r\n]+)$|([^\s`]+))/gu)) {
        if (line.slice(0, match.index).split('`').length % 2 === 0) continue;
        paths.add(normalizeQuery(match[1] ?? match[2] ?? match[3]).replace(/[，；,;]+$/u, ''));
      }
    }
    return prose;
  });
  return paths;
}

/**
 * Append the validated references to a rewrite.
 *
 * References land on their own lines at the very end. The composer's mention
 * grammar needs `@` at a line start or after whitespace, and appending keeps a
 * leading slash command or mention exactly where the author had it.
 *
 * Each group gets a heading line. Both headings are ours: a previous run's
 * heading is recognised and rebuilt rather than stacked, and a heading inside a
 * code fence is left alone as an example.
 *
 * @param prompt - the rewritten prompt.
 * @param files - validated file references.
 * @param skills - validated skill references.
 * @returns the bounded prompt and only newly appended file and skill entries.
 */
function appendReferences(prompt, files, skills) {
  const mentions = existingFileMentions(prompt);
  const escapedSkillMarker = SKILL_REFERENCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedFileMarker = FILE_REFERENCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(`^${escapedSkillMarker}\\r?\\n(?:[\\p{L}\\p{N}_.:/-]+\\r?(?:\\n|$))+`, 'gmu');
  /* Our own file group: the heading plus the mention lines it introduces. */
  const filePattern = new RegExp(`^${escapedFileMarker}\\r?\\n(?:@[^\\r\\n]*\\r?(?:\\n|$))+`, 'gmu');
  const knownSkills = new Set();
  const knownMentions = [];
  const knownMentionSet = new Set();
  const keepMention = (token) => {
    if (knownMentionSet.has(token)) return;
    knownMentionSet.add(token);
    knownMentions.push(token);
  };
  /* Consolidate only our own well-formed groups, preserving other prose. */
  const base = outsideFences(prompt, (prose) => prose
    .replace(filePattern, (block) => {
      block.split(/\r?\n/u).slice(1).filter(Boolean).forEach(keepMention);
      return '';
    })
    .replace(blockPattern, (block) => {
      block.split(/\r?\n/u).slice(1).filter(Boolean).forEach((entry) => knownSkills.add(entry));
      return '';
    })).trimEnd();
  const acceptedFiles = [];
  const acceptedSkills = [];
  const render = () => [
    base,
    /* Existing mentions are re-emitted unchanged; a guard both keeps them and
       stops an already-mentioned path from being listed twice. */
    knownMentions.length > 0
      ? `${FILE_REFERENCE_MARKER}\n${knownMentions.join('\n')}` : '',
    knownSkills.size > 0 ? `${SKILL_REFERENCE_MARKER}\n${[...knownSkills].join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  for (const file of files) {
    /* A mention a previous group already carries is re-emitted as it was; one
       the prose already used needs no group entry at all. */
    if (knownMentionSet.has(file.token)) {
      keepMention(file.token);
      continue;
    }
    if (mentions.has(normalizeQuery(file.token))) continue;
    keepMention(file.token);
    if (render().length > MAX_INPUT_CHARS) {
      knownMentionSet.delete(file.token);
      knownMentions.pop();
      continue;
    }
    mentions.add(normalizeQuery(file.token));
    acceptedFiles.push(file);
  }
  for (const skill of skills) {
    /* The block carries gestures, not bare names: `/name` is what DSH turns into
       a skill load when the user sends the prompt. */
    const gesture = formatSkillGesture(skill.name);
    if (gesture === undefined || knownSkills.has(gesture)) continue;
    knownSkills.add(gesture);
    if (render().length > MAX_INPUT_CHARS) {
      knownSkills.delete(gesture);
      continue;
    }
    acceptedSkills.push(skill);
  }
  const result = render();
  /* Existing blocks can have significant spacing; never exceed the final limit. */
  if (result.length > MAX_INPUT_CHARS) return { prompt, files: [], skills: [], limited: true };
  return {
    prompt: result,
    files: acceptedFiles,
    skills: acceptedSkills,
    limited: files.some((file) => !mentions.has(normalizeQuery(file.token)))
      || skills.some((skill) => !knownSkills.has(formatSkillGesture(skill.name))),
  };
}

/** Restore the original draft if a concrete path or an explicit mention vanished. */
function lostOriginalPaths(rewrite, original, nominations) {
  const paths = new Set();
  for (const match of original.matchAll(/@(?:"([^"\r\n]+)"|([^\s,;，；]+))/gu)) {
    paths.add(normalizeQuery(match[1] ?? match[2]).replace(/[.,:!?，。：！？)）\]}`]+$/u, ''));
  }
  for (const match of original.matchAll(/(?:[\w.-]+[\\/])+[\w.-]+/gu)) {
    if (!original.slice(Math.max(0, match.index - 3), match.index).includes('://')) {
      paths.add(normalizeQuery(match[0]).replace(/\.+$/u, ''));
    }
  }
  for (const match of original.matchAll(/[\w-][\w.-]*\.(?:[cm]?[jt]sx?|json|ya?ml|md|html?|css|scss|py|go|rs|java|sh|sql|toml|xml|vue|svelte)\b/gu)) {
    paths.add(match[0]);
  }
  const normalizedOriginal = original.replaceAll('\\', '/');
  for (const nomination of nominations) {
    const query = normalizeQuery(nomination);
    if (query && normalizedOriginal.includes(query)) paths.add(query);
  }
  const normalizedRewrite = rewrite.replaceAll('\\', '/');
  return [...paths].filter((path) => path && !normalizedRewrite.includes(path));
}

/* ------------------------------------------------------------ rewrite answer */

/** Parse a complete JSON object, optionally enclosed by a single JSON fence. */
function parseWholeObject(text) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  try {
    const value = JSON.parse(fenced === null ? trimmed : fenced[1]);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read the model's rewrite answer, tolerating both envelope shapes.
 *
 * A model asked for the JSON envelope usually returns it, but may wrap it in a
 * code fence or ignore the instruction. A plain-text answer is still a usable
 * rewrite, so it degrades to one instead of failing; `enveloped` tells the caller
 * that the nominations are missing and worth a follow-up question.
 *
 * @param text - assistant text exactly as streamed.
 * @param files - whether file nominations were requested.
 * @param skillMode - the skill tier.
 * @returns the rewrite, any nominations, and whether an envelope arrived.
 */
function readRewriteAnswer(text, files = true, skillMode = DEFAULT_SKILL_MODE) {
  const skills = skillMode !== 'off';
  const parsed = files || skills ? parseWholeObject(text) : null;
  const validList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (parsed !== null && typeof parsed.prompt === 'string'
    && (!files || validList(parsed.files)) && (!skills || validList(parsed.skills))) {
    return {
      prompt: parsed.prompt,
      files: files ? parsed.files : [],
      skills: skills ? parsed.skills : [],
      enveloped: true,
    };
  }
  /* Preserve arbitrary prose and JSON examples; never extract an embedded object. */
  return { prompt: text.trim(), files: [], skills: [], enveloped: false };
}

/**
 * Ask the model once more for the nominations its rewrite omitted.
 *
 * The prompt text is already final by now, so this call only names files and
 * skills. A model that ignored the envelope still knows which files the task
 * touches, and the narrow question is what surfaces it.
 *
 * @param llm - live LLM service.
 * @param route - the route the rewrite used.
 * @param prompt - the finished rewrite.
 * @param candidatePaths - real workspace paths to choose from, when available.
 * @param candidateSkills - the skills this agent can load, when available.
 * @param skillMode - the skill tier, or `'off'`.
 * @param files - whether missing file nominations should be requested.
 * @param signal - bounded nomination deadline.
 * @returns nominated paths and skill names, empty when the answer is unusable.
 */
async function nominateReferences(llm, route, prompt, candidatePaths = [], candidateSkills = [], skillMode = DEFAULT_SKILL_MODE, files = true, signal) {
  const skills = skillMode !== 'off';
  const supplied = [
    candidatePaths.length === 0 ? '' : `<workspace_paths>\n${candidatePaths.join('\n')}\n</workspace_paths>`,
    candidateSkills.length === 0 ? '' : `<available_skills>\n${candidateSkills.join('\n')}\n</available_skills>`,
  ].filter(Boolean);
  const userText = supplied.length === 0 ? prompt : `${prompt}\n\n${supplied.join('\n\n')}`;
  const fields = [files ? '"files": string[]' : '', skills ? '"skills": string[]' : ''].filter(Boolean);
  const fileRule = candidatePaths.length === 0
    ? 'Nominate at most 5 workspace-relative file paths or distinctive fragments, most relevant first.'
    : 'For "files": copy at most 5 paths from <workspace_paths>, most relevant first. Never invent a path and never copy an entry the task does not need.';
  const system = `You extract references required by a coding task.
Reply with ONE JSON object and nothing else: { ${fields.join(', ')} }.
${files ? fileRule : 'Do not nominate files.'}
${skills ? skillCandidateRule(skillMode, candidateSkills.length > 0) : 'Do not nominate skills.'}
Use empty arrays when nothing applies.`;
  const text = await withSignal(() => callModel(llm, route, system, textContent(userText), signal), signal);
  const parsed = parseWholeObject(text);
  const valid = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (parsed === null || (files && !valid(parsed.files)) || (skills && !valid(parsed.skills))) {
    throw new Error('the reference nomination response was not a valid JSON object');
  }
  return { files: files ? parsed.files : [], skills: skills ? parsed.skills : [] };
}

/* --------------------------------------------------------- rewrite pipeline */

/**
 * Rewrite one composer draft and append the references the rewrite depends on.
 *
 * @param ctx - host context, read for the deployment default model and services.
 * @param state - current settings document.
 * @param text - exact composer draft.
 * @param llm - live LLM service.
 * @param sessionId - Session whose working directory bounds reference discovery.
 * @param images - validated draft images.
 * @returns `{ prompt, route, imageStatus, referenceStatus, files, skills, preserved?, notes? }`.
 * @throws when the draft is invalid, no route exists, or the model call fails.
 */
async function optimizePrompt(ctx, state, text, llm, sessionId, images) {
  if (text.trim() === '') throw httpError('there is nothing to optimize', 400);
  if (text.length > MAX_INPUT_CHARS) {
    throw httpError(`the draft is ${text.length} characters; the limit is ${MAX_INPUT_CHARS}`, 400);
  }

  const route = await resolveRoute(llm, ctx.get('agentDefaultModel'), state);
  const wantFiles = state.referenceFiles;
  const skillMode = state.skillMode;
  const wantSkills = skillMode !== 'off';
  const userText = `Rewrite the following composer text.\n\n<composer_text>\n${text}\n</composer_text>`;

  let content = textContent(userText);
  let imageStatus = images.length === 0 ? 'unused' : 'disabled';
  let imageError;
  if (images.length > 0 && state.includeImages !== false) {
    const composed = await composeUserContent(ctx, llm, route, images, userText);
    content = composed.content;
    imageStatus = composed.status;
    imageError = composed.error;
  }

  const answer = readRewriteAnswer(
    await callModel(llm, route, composeSystemPrompt(state.systemPrompt, wantFiles, skillMode), content),
    wantFiles,
    skillMode,
  );
  if (answer.prompt.trim() === '') throw new Error('the model returned no usable prompt text');
  if (answer.prompt.length > MAX_INPUT_CHARS) {
    throw new Error('the optimized prompt came back longer than the composer limit');
  }

  /* Preserve the draft rather than write back a version that lost a path or a
     reference the author explicitly included. */
  const lost = lostOriginalPaths(answer.prompt, text, answer.files);
  if (lost.length > 0) {
    return {
      prompt: text,
      route,
      imageStatus,
      referenceStatus: 'preserved',
      files: [],
      skills: [],
      preserved: true,
      ...(imageError === undefined ? {} : { imageError }),
    };
  }

  const agent = sessionId === '' ? undefined : ctx.get('agents')?.get(sessionId);
  const cwd = agent?.ctx?.get('session')?.cwd;
  const referenceDeadline = Date.now() + REFERENCE_TIMEOUT_MS;
  const referenceSignal = AbortSignal.timeout(REFERENCE_TIMEOUT_MS);
  const notes = [];
  let files = [];
  let skills = [];

  const resolve = async (nominations, resolveFiles, resolveSkills) => {
    await Promise.all([
      (async () => {
        if (!resolveFiles || nominations.files.length === 0) return;
        try {
          files = await resolveFileReferences(ctx, agent, nominations.files, referenceSignal, notes);
        } catch (error) {
          notes.push(String(error?.message ?? error));
        }
      })(),
      (async () => {
        if (!resolveSkills || nominations.skills.length === 0) return;
        try {
          skills = await resolveSkillReferences(ctx, agent, cwd, nominations.skills, skillMode, referenceSignal);
        } catch (error) {
          notes.push(String(error?.message ?? error));
        }
      })(),
    ]);
  };

  await resolve(answer, wantFiles, wantSkills);
  const needFiles = wantFiles && files.length === 0;
  const needSkills = wantSkills && skills.length === 0;
  if ((wantFiles || wantSkills) && agent === undefined) notes.push('reference processing unavailable: no live agent');
  if (needFiles && ctx.get('fileReferences') === undefined) notes.push('file reference index unavailable');
  if (needSkills && ctx.get('skills') === undefined) notes.push('skill catalog unavailable');

  /* Both sides ask the same way: an empty result means "ask once more, with the
     real candidates in hand". A model cannot read the skill catalog itself, so
     an unaided name request reliably answers "none". */
  if ((needFiles || needSkills) && agent !== undefined && !referenceSignal.aborted) {
    let candidates = [];
    if (needFiles) {
      const service = ctx.get('fileReferences');
      if (service !== undefined) {
        const discoverySignal = AbortSignal.any([referenceSignal, AbortSignal.timeout(5000)]);
        candidates = await listWorkspacePaths(service, agent, discoverySignal, text, notes);
      }
    }
    const candidateSkills = needSkills
      ? await listAvailableSkills(ctx, agent, cwd, referenceSignal)
      : [];
    /* Reserve time for validation inside the single reference-stage deadline. */
    const nominationBudget = referenceDeadline - Date.now() - 3000;
    if (nominationBudget > 0) {
      const nominationSignal = AbortSignal.any([referenceSignal, AbortSignal.timeout(nominationBudget)]);
      try {
        const nominations = await nominateReferences(
          llm,
          route,
          answer.prompt,
          candidates,
          candidateSkills,
          needSkills ? skillMode : 'off',
          needFiles,
          nominationSignal,
        );
        await resolve(nominations, needFiles, needSkills);
      } catch (error) {
        notes.push(`reference nomination failed: ${String(error?.message ?? error)}`);
      }
    } else {
      notes.push('reference nomination skipped: insufficient time remains for validation');
    }
  }

  const appended = appendReferences(answer.prompt, files, skills);
  if (appended.limited) notes.push('some references were omitted to stay within the composer length limit');
  const addedReferences = appended.files.length + appended.skills.length;
  const referenceStatus = !wantFiles && !wantSkills
    ? 'disabled'
    : notes.length > 0 ? 'partial'
      : addedReferences > 0 ? 'complete' : 'none';

  return {
    prompt: appended.prompt,
    route,
    imageStatus,
    referenceStatus,
    files: appended.files.map((file) => file.path),
    skills: appended.skills.map((skill) => skill.name),
    ...(imageError === undefined ? {} : { imageError }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/* --------------------------------------------------------------- plugin body */

/**
 * Host plugin body.
 *
 * @param ctx - the plugin context.
 */
function apply(ctx) {
  /** In-memory copy every reader shares; the file remains the durable copy. */
  const live = { state: normalizeState({}) };
  const ready = readState().then((state) => {
    live.state = state;
    return state;
  });

  ctx.inject(['webServer'], (webCtx) => {
    /** Read the LLM service at call time: its carrier may arrive after this row. */
    const llmService = () => {
      const service = ctx.get('llm');
      if (service === undefined) throw httpError('the LLM service is not available in this composition', 503);
      return service;
    };

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: (req, res) => {
          const method = req.method || 'GET';
          if (method === 'GET' || method === 'HEAD') {
            ready.then(
              () => {
                if (method === 'HEAD') {
                  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                  res.end();
                  return;
                }
                sendJson(res, 200, live.state);
              },
              (error) => sendJson(res, 500, { error: String(error?.message ?? error) }),
            );
            return;
          }
          if (method !== 'POST') {
            res.writeHead(405, { allow: 'GET, HEAD, POST' });
            res.end();
            return;
          }
          readJsonBody(req).then(
            async (patch) => {
              await ready;
              const next = normalizeState({ ...live.state, ...patch });
              try {
                await saveState(next);
              } catch (error) {
                sendJson(res, 500, { error: `could not write ${statePath()}: ${error?.message ?? error}` });
                return;
              }
              live.state = next;
              sendJson(res, 200, next);
            },
            (error) => sendJson(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }),
          );
        },
      }),
      'optimize-prompts: settings route',
    );

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: RUN_ROUTE,
        handler: (req, res) => {
          if ((req.method || 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          readJsonBody(req).then(
            async (body) => {
              const text = typeof body.text === 'string' ? body.text : '';
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
              try {
                const llm = llmService();
                const images = readRequestImages(body.images);
                const result = await optimizePrompt(ctx, live.state, text, llm, sessionId, images);
                sendJson(res, 200, result);
              } catch (error) {
                sendJson(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) });
              }
            },
            (error) => sendJson(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }),
          );
        },
      }),
      'optimize-prompts: run route',
    );

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: REPORT_ROUTE,
        handler: (req, res) => {
          if ((req.method || 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          readJsonBody(req).then(
            (body) => {
              /* Client-side failures have no other Host-side sink. */
              process.stderr.write(`[optimize-prompts] client report: ${String(body.message ?? body)}\n`);
              sendJson(res, 200, { ok: true });
            },
            () => {
              res.writeHead(204);
              res.end();
            },
          );
        },
      }),
      'optimize-prompts: client report route',
    );
  });
}

export { apply, inject, name };
