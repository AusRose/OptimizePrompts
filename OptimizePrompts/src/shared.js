/* ------------------------------------------------------------------ identity */

/**
 * Plugin identity. The same string is used in four places:
 *
 *   1. the Cordis row id in `cordis.patch.yml`;
 *   2. the browser module id the client loader registers;
 *   3. the locale namespace;
 *   4. the settings file name under `$DSH_HOME`.
 *
 * Keeping one constant avoids the classic "host loaded, client never registered"
 * mismatch after a rename.
 */
const PACKAGE_NAME = 'dsh-optimize-prompts';

/** Durable settings document: GET reads it, POST merges a patch into it. */
const STATE_ROUTE = '/optimize-prompts/state';

/** One rewrite request: compose the draft and call the model. */
const RUN_ROUTE = '/optimize-prompts/run';

/** Client-side failure sink, so a failed click is also visible in the Host log. */
const REPORT_ROUTE = '/optimize-prompts/report';

/* ------------------------------------------------------------------- limits */

/** Longest draft accepted for one rewrite, in characters. */
const MAX_INPUT_CHARS = 60000;

/** Upper bound on generated prompt length, in tokens. */
const MAX_OUTPUT_TOKENS = 4096;

/** One model call must settle within this many milliseconds. */
const REQUEST_TIMEOUT_MS = 120000;

/**
 * Whole-request body cap. Images arrive base64-encoded inside JSON, so this
 * budget is deliberately larger than the per-image cap: four images at 8 MiB
 * base64 each still fit. The Host buffers the body in memory, so this is also
 * the memory ceiling for one request.
 */
const MAX_BODY_BYTES = 40 * 1024 * 1024;

/** Largest single image accepted from the browser, in base64 characters. */
const MAX_REQUEST_IMAGE_CHARS = 8 * 1024 * 1024;

/**
 * Most draft images one rewrite forwards. The browser truncates to this before
 * sending and the Host re-checks it, so a large pasted batch can never become an
 * unbounded upload.
 */
const MAX_REQUEST_IMAGES = 4;

/**
 * The post-request reference lookups get their own, much shorter deadline.
 * A slow workspace index must not hold the composer for another two minutes.
 */
const REFERENCE_TIMEOUT_MS = 15000;

/** Most workspace paths shown to the candidate question. */
const CANDIDATE_PATH_BUDGET = 160;

/** Most skills listed for the candidate question. */
const CANDIDATE_SKILL_BUDGET = 40;

/** Upper bound on file paths the model may nominate for one rewrite. */
const MAX_FILE_NOMINATIONS = 5;

/** Upper bound for the capped skill tiers (strict and balanced); eager has none. */
const MAX_SKILL_NOMINATIONS = 3;

/**
 * Preferred route when the user has not chosen one.
 *
 * DeepSeek Flash accepts images, which makes the image-aware rewrite work out of
 * the box. The Host verifies that the provider and model are still advertised
 * before using this pair, then falls back to the deployment default.
 */
const PREFERRED_PROVIDER = 'deepseek-account';
const PREFERRED_MODEL = 'deepseek-flash';

/**
 * Directory names the candidate listing probes when a provider cannot list the
 * workspace root. Task paths and real root entries take precedence.
 */
const CANDIDATE_DIRECTORY_HINTS = [
  'web', 'src', 'app', 'apps', 'internal', 'pkg', 'cmd', 'lib', 'server', 'client',
  'api', 'packages', 'public', 'static', 'assets', 'components', 'pages', 'routes',
  'handlers', 'handler', 'controllers', 'models', 'services', 'views', 'templates',
  'docs', 'test', 'tests', 'scripts', 'config', 'configs', 'migrations', 'sql',
  'deploy', 'ui', 'dashboard', 'frontend', 'backend',
];

/* --------------------------------------------------------------- references */

/**
 * Marker opening the appended file-reference group.
 *
 * Kept to the heading alone: DSH already teaches the agent what an `@` token
 * means. The line is recognized again on the next run, so repeated
 * optimizations rebuild this group instead of stacking a second heading.
 */
const FILE_REFERENCE_MARKER = 'Files this task needs:';

/**
 * Marker opening the appended skill-reference block.
 *
 * Each entry is the `/name` gesture DSH scans for in the claimed user message.
 * A bare name would only work if the agent chose to call the `skill` tool, so the
 * gesture is what makes the reference actionable the moment the user sends it.
 */
const SKILL_REFERENCE_MARKER = 'Skills this task may need:';

/**
 * How eagerly the rewrite nominates skills.
 *
 * The catalog a workspace exposes is not always relevant, and the model's
 * willingness to name an entry swings widely. The tier the user picks is the
 * wording the model receives; every tier still goes through the same catalog
 * validation.
 */
const SKILL_MODES = ['off', 'strict', 'balanced', 'eager'];

/** The tier a workspace with no stored preference gets. */
const DEFAULT_SKILL_MODE = 'balanced';

/**
 * Render one workspace path as the reference token DSH's composer grammar
 * recognizes, or `undefined` for a path that grammar cannot represent safely.
 *
 * Mirrors `formatFileMention` in `@deepseek-ai/dsh-file-reference/grammar`:
 * `@path` normally, `@"path"` when the path contains whitespace, `@"dir` for a
 * directory the user is meant to list, and no token for a path the editor cannot
 * quote.
 *
 * @param path - workspace-relative path, already normalized to `/`.
 * @param kind - file or directory, as the file-reference index reported it.
 * @returns the reference token, or `undefined` when it cannot be rendered.
 */
function formatFileMention(path, kind) {
  if (typeof path !== 'string' || path === '') return undefined;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  const suffix = kind === 'directory' ? '/' : '';
  const target = `${path}${suffix}`;
  if (!/\s/u.test(target)) return `@${target}`;
  return kind === 'directory' ? `@"${target}` : `@"${target}"`;
}

/**
 * Render one skill name as the gesture DSH recognizes in a user message.
 *
 * The scanner accepts `/([a-z0-9]+(?:-[a-z0-9]+)*)`, so a name outside that
 * grammar could never be invoked; it is refused here rather than appended as a
 * token that silently does nothing.
 *
 * @param name - catalog skill name.
 * @returns `/name`, or `undefined` when the gesture grammar cannot carry it.
 */
function formatSkillGesture(name) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return undefined;
  return `/${name}`;
}

/**
 * The skill half of the envelope request, worded for one tier.
 *
 * @param mode - one of `SKILL_MODES`.
 * @returns the instruction line.
 */
function skillNominationRule(mode) {
  switch (mode) {
    case 'strict':
      return 'For "skills": list a skill only when the request names the capability it provides or the task cannot be done without it; at most 2, empty otherwise.';
    case 'eager':
      return 'For "skills": list every skill that could plausibly improve this task, most useful first, with no count limit. Include a skill when a reasonable colleague would consider using it, even if the request does not name it.';
    default:
      return 'For "skills": list only skills you are confident exist and that this task needs, at most 3. Use an empty array when none apply.';
  }
}

/**
 * The skill half of the candidate question, worded for one tier.
 *
 * The listing is the same either way; only the bar for choosing from it moves,
 * so the tier never widens what can be referenced — the catalog still has the
 * final say on whether the name exists.
 *
 * @param mode - one of `SKILL_MODES`.
 * @param hasCandidates - whether the real catalog was handed over.
 * @returns the instruction line.
 */
function skillCandidateRule(mode, hasCandidates) {
  if (!hasCandidates) {
    switch (mode) {
      case 'strict':
        return 'Do not nominate skills unless the request explicitly needs one; an empty array is the normal answer.';
      case 'eager':
        return 'Name every skill that would plausibly help, even when the request does not name the capability; do not cap the number.';
      default:
        return 'Nominate at most 3 skill names you are confident exist and this task needs.';
    }
  }
  switch (mode) {
    case 'strict':
      return 'For "skills": choose a name from <available_skills> only when the request names that capability or the task cannot be done without it, at most 2. An empty array is the normal answer.';
    case 'eager':
      return 'For "skills": choose every name from <available_skills> that would plausibly improve this task, most useful first — include one when a reasonable colleague would consider using it, even if the request does not name it. Do not cap the number.';
    default:
      return 'For "skills": choose at most 3 names from <available_skills> that this task would genuinely benefit from, exactly as listed. An empty array is correct only when none of them help.';
  }
}

/**
 * The hard cap on skill nominations for one tier.
 *
 * Only the capped tiers use `MAX_SKILL_NOMINATIONS`; `eager` promises to take
 * every skill that could help, so it must not silently drop the tail of that
 * list. The Host's composer length limit still bounds the final prompt.
 *
 * @param mode - one of `SKILL_MODES`.
 * @returns the maximum number of nominations to keep.
 */
function skillNominationLimit(mode) {
  return mode === 'eager' ? Infinity : MAX_SKILL_NOMINATIONS;
}

/* ------------------------------------------------------------------ prompts */

/**
 * The plain output contract stated by the default instruction.
 *
 * It is a named constant for two reasons: the settings page can restore the
 * default instruction, and `composeSystemPrompt` must remove this exact
 * paragraph before appending the JSON envelope. Appending after a contract that
 * says "reply with the prompt only" loses, because the model follows the
 * instruction it read first.
 */
const PLAIN_OUTPUT_CONTRACT = `Output contract:
- Reply with the rewritten prompt only.
- No preamble, no explanation, no commentary, no surrounding quotes or code fences, and no trailing notes about what you changed.
- If the input is already a clear, complete prompt, return it with only light corrections instead of padding it.`;

/**
 * The instruction sent as the system prompt unless the user edits it.
 *
 * The rules are intentionally about *rewriting*, not answering: the model must
 * not start solving the task or invent requirements the author did not write.
 * Language is preserved because a Chinese draft optimized into English would
 * surprise the person who is about to send it.
 */
const DEFAULT_SYSTEM_PROMPT = `You are PromptPilot, a prompt-engineering assistant embedded in a coding agent's composer.

The user hands you the text currently sitting in their message box. Rewrite it into a clearer, higher-signal prompt that the agent can act on immediately.

Rules:
- Preserve the author's intent, language, and every concrete detail: names, paths, commands, identifiers, numbers, constraints, and code blocks. Never invent requirements, and never answer the request yourself.
- Keep the text in the same natural language the author wrote in (Chinese stays Chinese, English stays English).
- For an explicit task, make vague actions concrete and add only the details that naturally belong to it.
- For a question or an open-ended description, clarify the subject and the expected result; do not choose a technology stack, prescribe an output format, or invent facts the author did not provide.
- Structure only as much as the content earns: plain prose for a short ask, a short labelled list when there are several distinct requirements. Never force a template onto a simple request.
- Keep any leading slash command, @mention, or file reference exactly where the author put it, and keep it on the first line.

${PLAIN_OUTPUT_CONTRACT}`;

/**
 * The JSON envelope instruction appended when the rewrite must also nominate the
 * files and skills it depends on.
 *
 * The model never writes a reference token itself: it names paths and skill
 * names, and the Host validates every nomination against the live file index and
 * skill catalog before anything reaches the composer. That split is what keeps a
 * hallucinated path out of the prompt.
 *
 * @param files - whether file nominations are collected.
 * @param skillMode - the skill tier, or `'off'` to collect none.
 * @returns the instruction, or an empty string when neither is enabled.
 */
function buildEnvelopeInstruction(files, skillMode) {
  const skills = skillMode !== 'off';
  if (!files && !skills) return '';
  const fields = ['"prompt": string — the rewritten prompt'];
  if (files) fields.push('"files": string[] — workspace-relative paths, or distinctive path fragments');
  if (skills) fields.push('"skills": string[] — kebab-case names of skills this task needs');
  const rules = [
    'Output contract (overrides any other output instruction):',
    `- Reply with ONE JSON object and nothing else: { ${fields.join(', ')} }.`,
    '- No prose around it, no code fence, no trailing text.',
  ];
  if (files) {
    rules.push('- For "files": list only files this task genuinely depends on, most relevant first, at most 5. Give the most specific path you can justify from the request; when you cannot name a real path, use a distinctive fragment of one. Never invent a file you have no reason to believe exists, and never list a file the request does not need.');
    rules.push('- "files" is a separate index of what the agent should open. It is NEVER a substitute for the prompt text: keep every subject, noun, and path the author wrote exactly where it belongs in "prompt". Deleting a phrase from "prompt" because it also appears in "files" produces a broken sentence and is not allowed.');
  }
  if (skills) rules.push(`- ${skillNominationRule(skillMode)}`);
  rules.push('- Include every field even when it is empty, and prefer an empty list over a guess.');
  return `\n\n${rules.join('\n')}`;
}

/**
 * Compose the system instruction for one rewrite.
 *
 * @param systemPrompt - the user's configured instruction.
 * @param files - whether file nominations are collected.
 * @param skillMode - the skill tier, or `'off'` to collect none.
 * @returns the instruction the model receives.
 */
function composeSystemPrompt(systemPrompt, files, skillMode) {
  const envelope = buildEnvelopeInstruction(files, skillMode);
  if (envelope === '') return systemPrompt;
  return `${systemPrompt.replace(PLAIN_OUTPUT_CONTRACT, '').trimEnd()}${envelope}`;
}

/* ----------------------------------------------------------------- settings */

/**
 * Coerce one stored skill tier, including the boolean this setting replaced.
 *
 * @param value - stored `skillMode`, or the older `referenceSkills` boolean.
 * @returns one of `SKILL_MODES`.
 */
function normalizeSkillMode(value) {
  if (typeof value === 'string' && SKILL_MODES.includes(value)) return value;
  if (typeof value === 'boolean') return value ? 'balanced' : 'off';
  return DEFAULT_SKILL_MODE;
}

/**
 * Coerce one stored document onto the defaults.
 *
 * A settings file can be truncated, hand-edited, or written by an older build,
 * so every field is validated instead of trusted. An empty provider or model
 * means "unset": the Host then falls back to its preferred route or the
 * deployment default.
 *
 * @param input - unknown value read from disk or posted by the browser.
 * @returns a complete, safe settings document.
 */
function normalizeState(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const text = (value) => (typeof value === 'string' ? value : '');
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const systemPrompt = text(source.systemPrompt).trim();
  return {
    provider: text(source.provider).trim(),
    model: text(source.model).trim(),
    reasoningEffort: text(source.reasoningEffort).trim(),
    systemPrompt: systemPrompt === '' ? DEFAULT_SYSTEM_PROMPT : systemPrompt,
    /* Both reference features and image context are opt-out: a fresh install and
       an older document keep them enabled. */
    referenceFiles: flag(source.referenceFiles, true),
    skillMode: normalizeSkillMode(source.skillMode ?? source.referenceSkills),
    includeImages: flag(source.includeImages, true),
  };
}

/** Defaults built through the same validator so the shapes cannot drift. */
const DEFAULT_STATE = normalizeState({});
