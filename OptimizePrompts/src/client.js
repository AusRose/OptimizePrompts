/**
 * dsh-optimize-prompts — browser half.
 *
 * Two additive surfaces:
 *
 *   1. `conversation.input.left` — a compact "优化" control beside the
 *      composer's permission preset ("工作区内修改"). It appears only while the
 *      draft has text, turns into a spinner while the call is in flight, and
 *      replaces the draft through the conversation input actions. It never
 *      sends.
 *   2. `settings.section` — model, reasoning effort, image preference, and the
 *      rewrite instruction.
 *
 * The durable settings and the model call live in the Host half; this half only
 * reads and writes them over same-origin routes.
 *
 * @module dsh-optimize-prompts/client
 */

import { IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconLoadingOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * The React runtime the loader exposes as a module-global. The `require`
 * fallback keeps the bundle usable in a wrapper that only ships the module
 * factory.
 */
const ReactRuntime = typeof React === 'undefined' ? require('react') : React;
const { useEffect, useRef, useState } = ReactRuntime;

/** A text-and-spark mark that follows the button's theme and state colors. */
function OptimizeSparkIcon({ size = 16, ...props }) {
  return ReactRuntime.createElement('svg', {
    ...props,
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    focusable: 'false',
  }, [
    ReactRuntime.createElement('path', { key: 'text', d: 'M4 7h9M4 12h12M4 17h8' }),
    ReactRuntime.createElement('path', {
      key: 'spark',
      stroke: 'none',
      fill: 'currentColor',
      d: 'm18 2 1.35 3.65L23 7l-3.65 1.35L18 12l-1.35-3.65L13 7l3.65-1.35Z',
    }),
  ]);
}

/* Locale namespace every visible string of this plugin lives under. */
const NS = PACKAGE_NAME;

/* Simplified Chinese keys are the source of truth; English must match them. */
const zh = {
  'action.label': '优化',
  'action.labelBusy': '优化中',
  'action.labelDone': '已优化',
  'action.labelFailed': '重试',
  'action.title': '优化提示词（不发送）',
  'action.aria': '优化提示词（不发送）',
  'action.busy': '正在优化提示词…',
  'action.done': '已替换草稿，请检查后发送。',
  'action.failed': '优化失败：{message}',
  'action.preserved': '改写丢失了原始路径或引用，已保留原稿。',
  'image.sent': '已参考附图并替换草稿。',
  'image.disabled': '图片参考已关闭，本次只改写文字。',
  'image.textOnly': '所选模型不支持图片，已忽略附图。',
  'image.noStore': '当前环境没有附件服务，已忽略附图。',
  'image.failed': '图片未能送达模型，本次只改写文字。',
  'reference.statusHeading': '最近一次引用处理',
  'reference.complete': '引用已确认；本次新增 {files} 个文件引用、{skills} 个技能引用。',
  'reference.none': '未发现相关引用。',
  'reference.partial': '引用处理未全部完成；本次新增 {files} 个文件引用、{skills} 个技能引用。',
  'reference.preserved': '改写丢失了原始路径或引用，已保留原稿。',
  'reference.disabled': '自动引用已关闭。',
  'reference.heading': '自动引用',
  'reference.hint': '优化完成后，把这次改写真正依赖的文件与技能追加到提示词末尾。',
  'reference.files': '引用文件',
  'reference.filesHint': '由模型提名、再经当前工作区的文件索引校验；只保留真实存在的路径。',
  'reference.skills': '引用技能',
  'reference.skillsHint': '由模型提名、再经技能目录校验；命中的技能会以 /名称 形式列出。',
  'reference.skillMode.off': '关闭',
  'reference.skillMode.offHint': '不引用任何技能。',
  'reference.skillMode.strict': '严格',
  'reference.skillMode.strictHint': '只有请求明确需要某项能力时才引用，最多 2 个；通常为空。',
  'reference.skillMode.balanced': '均衡',
  'reference.skillMode.balancedHint': '只引用确实有帮助的技能，最多 3 个。',
  'reference.skillMode.eager': '宽松',
  'reference.skillMode.eagerHint': '只要可能有用就引用，不限数量；不确定时倾向给出。',
  'nav': '优化提示词',
  'intro': '在输入框的权限选择器旁点击「优化」，当前草稿会被重写成更清晰的提示词。结果只替换输入框内容，不会自动发送。',
  'model.heading': '模型',
  'model.hint': '使用 DSH 已配置的模型；此处列出的就是当前可路由的全部模型。',
  'model.search': '搜索模型…',
  'model.empty': '没有匹配的模型。',
  'model.aria': '选择模型，当前 {name}',
  'model.listAria': '模型列表',
  'model.statusLoading': '正在读取模型目录…',
  'model.statusError': '模型目录读取失败：{message}',
  'model.statusEmpty': '当前 DSH 没有可用模型。',
  'effort.heading': '思考强度',
  'effort.hint': '选“默认”时由模型自己决定强度。',
  'effort.default': '默认',
  'effort.unsupported': '当前模型未提供思考强度等级。',
  'effort.followUp': '只影响提示词优化，不会改变聊天会话的模型或思考强度。',
  'images.heading': '图片',
  'images.hint': '输入框里附带的图片会让改写看得见它们；图片仍随你发送的消息带出，不会被写进提示词。',
  'images.toggle': '让优化参考图片',
  'images.toggleHint': '关闭后改写只看到文字，附带的图片不会被发送给优化模型。',
  'toggle.on': '开',
  'toggle.off': '关',
  'prompt.heading': '优化指令',
  'prompt.hint': '发送给优化模型的系统提示词，决定重写风格。',
  'prompt.reset': '恢复默认',
  'status.saving': '正在保存…',
  'status.saved': '已保存',
  'status.failed': '保存失败：{message}',
  'lastError.heading': '最近一次优化失败',
  'about.heading': '关于',
  'about.body': '版本 {version}。优化走的是一次独立的模型请求，不会写入会话记录；输入框内容何时发送由你决定。',
};

/* English dictionary, keyed identically to the Chinese one. */
const en = {
  'action.label': 'Optimize',
  'action.labelBusy': 'Working',
  'action.labelDone': 'Done',
  'action.labelFailed': 'Retry',
  'action.title': 'Optimize prompt (does not send)',
  'action.aria': 'Optimize prompt (does not send)',
  'action.busy': 'Optimizing prompt…',
  'action.done': 'Draft replaced. Review it, then send when ready.',
  'action.failed': 'Optimization failed: {message}',
  'action.preserved': 'The rewrite lost original paths or references, so the original draft was kept.',
  'image.sent': 'Images were used and the draft was replaced.',
  'image.disabled': 'Image context is off; only the text was rewritten.',
  'image.textOnly': 'The selected model does not accept images; they were ignored.',
  'image.noStore': 'This composition has no attachment store; images were ignored.',
  'image.failed': 'The images could not reach the model; only the text was rewritten.',
  'reference.statusHeading': 'Last reference processing result',
  'reference.complete': 'References confirmed; added {files} file and {skills} skill reference(s).',
  'reference.none': 'No relevant references found.',
  'reference.partial': 'Reference processing was incomplete; added {files} file and {skills} skill reference(s).',
  'reference.preserved': 'The rewrite lost original paths or mentions; your original draft was preserved.',
  'reference.disabled': 'Automatic references are off.',
  'reference.heading': 'Automatic references',
  'reference.hint': 'After a rewrite, append the files and skills that rewrite actually depends on.',
  'reference.files': 'Reference files',
  'reference.filesHint': 'The model nominates paths and the workspace file index confirms them; only paths that really exist survive.',
  'reference.skills': 'Reference skills',
  'reference.skillsHint': 'The model nominates names and the skill catalog confirms them; matches are listed as /name.',
  'reference.skillMode.off': 'Off',
  'reference.skillMode.offHint': 'Never reference a skill.',
  'reference.skillMode.strict': 'Strict',
  'reference.skillMode.strictHint': 'Reference a skill only when the request names that capability, at most 2; usually none.',
  'reference.skillMode.balanced': 'Balanced',
  'reference.skillMode.balancedHint': 'Reference only skills that genuinely help, at most 3.',
  'reference.skillMode.eager': 'Eager',
  'reference.skillMode.eagerHint': 'Reference any skill that could help, with no count limit; prefer naming one when unsure.',
  'nav': 'Optimize Prompts',
  'intro': 'Click Optimize beside the composer permission selector and the current draft is rewritten into a clearer prompt. The result only replaces the composer text — it is never sent for you.',
  'model.heading': 'Model',
  'model.hint': 'Uses the models DSH already has configured; this list is exactly what can be routed right now.',
  'model.search': 'Search models…',
  'model.empty': 'No matching model.',
  'model.aria': 'Select model, current {name}',
  'model.listAria': 'Model list',
  'model.statusLoading': 'Loading the model catalog…',
  'model.statusError': 'The model catalog could not be loaded: {message}',
  'model.statusEmpty': 'This DSH composition exposes no model.',
  'effort.heading': 'Reasoning effort',
  'effort.hint': '"Default" lets the model decide its own effort.',
  'effort.default': 'Default',
  'effort.unsupported': 'This model exposes no reasoning effort levels.',
  'effort.followUp': 'Applies only to prompt optimization. Your conversation model and reasoning effort stay unchanged.',
  'images.heading': 'Images',
  'images.hint': 'Images attached to the draft are visible to the rewrite; they still travel with your message and are never copied into the prompt.',
  'images.toggle': 'Let the rewrite see images',
  'images.toggleHint': 'When off, the rewrite sees text only and attached images are not sent to the optimization model.',
  'toggle.on': 'On',
  'toggle.off': 'Off',
  'prompt.heading': 'Rewrite instruction',
  'prompt.hint': 'The system prompt sent to the optimization model; it decides the rewriting style.',
  'prompt.reset': 'Restore default',
  'status.saving': 'Saving…',
  'status.saved': 'Saved',
  'status.failed': 'Save failed: {message}',
  'lastError.heading': 'Last optimization failure',
  'about.heading': 'About',
  'about.body': 'Version {version}. The optimization is one standalone model request and is never written to the session log; you decide when the composer text is sent.',
};

/* Services this half needs before apply runs. */
const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session'];

/* ------------------------------------------------------------------- shared */

/** `t('key', { name: value })` with `{name}` interpolation. */
function translate(dict) {
  return (key, params) => {
    const template = dict[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  };
}

/** One stylesheet tag for this plugin, created on first use. */
const STYLE_TAG_ID = `${PACKAGE_NAME}-style`;

/**
 * All visual rules for both surfaces.
 *
 * Every color comes from a DSH theme token, so light, dark, and custom themes
 * work without a second stylesheet. The `OP-` prefix keeps the selectors out of
 * the shipped UI's way.
 */
const CSS = `
.OP-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;margin-inline-start:2px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;transition:background-color .12s,color .12s,opacity .12s}
.OP-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.OP-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.OP-btn:disabled{cursor:default;color:var(--dsw-alias-label-dimmed);opacity:1}
.OP-btn[data-busy=true]{color:var(--dsw-alias-state-business-primary)}
.OP-btn[data-failed=true]{color:var(--dsw-alias-state-error-primary)}
.OP-btn[data-done=true]{color:var(--dsw-alias-state-success-primary)}
.OP-spin{animation:OP-spin .9s linear infinite;transform-origin:50% 50%}
@keyframes OP-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.OP-spin{animation-duration:2.4s}}
.OP-page{display:flex;flex-direction:column;gap:16px;max-width:720px;padding:4px 0 24px;color:var(--dsw-alias-label-primary)}
.OP-page h3{margin:0;font-size:14px;font-weight:500;line-height:22px}
.OP-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.OP-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.OP-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.OP-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.OP-textarea{box-sizing:border-box;width:100%;min-height:180px;padding:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);line-height:1.6;resize:vertical;outline:none}
.OP-textarea:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary)}
.OP-ghost{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.OP-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.OP-picker{min-width:0;position:relative}
.OP-pickerTrigger{box-sizing:border-box;width:100%;height:36px;padding:0 8px 0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer;outline:none;display:flex;align-items:center;gap:6px}
.OP-pickerTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.OP-pickerTrigger:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}
.OP-pickerTrigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.OP-pickerValue{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.OP-pickerChevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform .12s var(--ds-ease-in-out, ease)}
.OP-pickerChevron[data-open=true]{transform:rotate(180deg)}
.OP-menu{z-index:1200;box-sizing:border-box;position:absolute;top:calc(100% + 4px);left:0;right:0;padding:4px;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));backdrop-filter:var(--dsw-menu-backdrop-filter,none);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);box-shadow:var(--dsw-elevation-prominent,var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.18)));color:var(--dsw-alias-label-primary);max-height:min(340px,60vh);overflow-y:auto}
.OP-menuSearch{box-sizing:border-box;flex:none;width:100%;height:32px;margin-bottom:4px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.OP-menuSearch::placeholder{color:var(--dsw-alias-label-tertiary)}
.OP-menuSearch:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.OP-groupLabel{padding:6px 10px 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.02em}
.OP-menuRow{display:flex;flex-direction:column;gap:1px}
.OP-menuEmpty{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.OP-option{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px 6px 10px;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.OP-option:hover:not(:disabled),.OP-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
.OP-option:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.OP-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.OP-optionCopy{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.OP-optionCheck{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.OP-menuHint{padding:6px 10px 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.OP-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.OP-toggleCopy{display:flex;flex-direction:column;gap:2px;min-width:0}
.OP-toggleLabel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.OP-togglePicker{flex:none;width:132px}
/* A picker in the narrow toggle column must not hand its 132px width to the
   menu: grow past the trigger and wrap the option name/hint instead of
   ellipsizing the hint on one line. */
.OP-togglePicker .OP-menu{left:auto;right:0;width:max-content;min-width:100%;max-width:min(320px,calc(100vw - 48px));max-height:min(440px,60vh)}
.OP-togglePicker .OP-option{align-items:flex-start;padding-top:7px;padding-bottom:7px}
.OP-togglePicker .OP-optionCopy{display:flex;flex-direction:column;gap:2px;overflow:visible;white-space:normal;text-overflow:clip}
.OP-togglePicker .OP-optionCheck{margin-top:1px}
.OP-togglePicker .OP-menuHint{padding:0}
.OP-switch{display:inline-flex;align-items:center;gap:8px;flex:none;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.OP-switch:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.OP-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.OP-switchTrack{box-sizing:border-box;display:inline-block;position:relative;width:34px;height:20px;flex:none;border-radius:10px;background:var(--dsw-alias-border-l2);transition:background-color .12s var(--ds-ease-in-out, ease)}
.OP-switch[data-on=true] .OP-switchTrack{background:var(--dsw-alias-state-business-primary)}
.OP-switchThumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-static-neutral-00);transition:transform .12s var(--ds-ease-in-out, ease)}
.OP-switch[data-on=true] .OP-switchThumb{transform:translateX(14px)}
.OP-switchState{min-width:1.5em;text-align:right}
.OP-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.OP-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.OP-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.OP-error{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
`;

/** Insert the plugin stylesheet once; the disposer removes it. */
function ensureStyleTag() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.getElementById(STYLE_TAG_ID);
  if (existing !== null) return () => {};
  const tag = document.createElement('style');
  tag.id = STYLE_TAG_ID;
  tag.setAttribute('data-plugin', PACKAGE_NAME);
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

/* -------------------------------------------------------- settings document */

/**
 * The durable settings, held in one module-level store.
 *
 * The Host copy is authoritative, but a patch applies locally first so the page
 * answers a click immediately; a failure is surfaced instead of silently
 * diverging. Saves are serialized so rapid changes cannot arrive out of order.
 */
const settingsStore = (() => {
  let value;
  const listeners = new Set();
  let inflight = null;
  let lastError = null;
  let pendingSave = null;
  let saving = false;
  let snapshot = { value, error: lastError, saving };

  const emit = () => {
    snapshot = { value, error: lastError, saving };
    for (const listener of [...listeners]) listener();
  };

  const load = () => {
    if (inflight !== null) return inflight;
    inflight = fetch(STATE_ROUTE, { headers: { accept: 'application/json' } }).then(
      async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
    ).then((data) => {
      if (data === null || typeof data !== 'object') throw new Error('invalid settings response');
      value = data;
      lastError = null;
      emit();
      return value;
    }).catch((error) => {
      lastError = String(error?.message ?? error);
      emit();
      return value;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const save = async () => {
    pendingSave = value;
    if (saving || pendingSave === undefined) return;
    saving = true;
    emit();
    try {
      while (pendingSave !== null) {
        const patch = pendingSave;
        pendingSave = null;
        try {
          const response = await fetch(STATE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error ?? `HTTP ${response.status}`);
          }
          const saved = await response.json();
          if (pendingSave === null) value = saved;
          lastError = null;
        } catch (error) {
          lastError = String(error?.message ?? error);
        }
        emit();
      }
    } finally {
      saving = false;
      emit();
    }
  };

  return {
    get: () => snapshot,
    error: () => lastError,
    saving: () => saving,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () => {
      if (value === undefined) load().catch(() => {});
    },
    patch: (next) => {
      value = { ...(value ?? {}), ...next };
      lastError = null;
      emit();
      save();
    },
  };
})();

/** Subscribe one component to the settings document. */
function useSettings() {
  return ReactRuntime.useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get).value;
}

/* ------------------------------------------------------------- model catalog */

/** The live Host model catalog, fetched once per page load. */
const catalogStore = (() => {
  let value = null;
  let status = 'idle';
  let error = null;
  let snapshot = { value, status, error };
  const listeners = new Set();

  const emit = () => {
    snapshot = { value, status, error };
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: (ctx) => {
      if (status !== 'idle' || ctx === null) return;
      status = 'loading';
      emit();
      ctx.remote.session.modelCatalog().then((response) => {
        if (response === null || typeof response !== 'object' || !response.ok) {
          throw new Error(response?.error?.message ?? 'the model catalog could not be loaded');
        }
        value = response.value;
        status = 'ready';
        error = null;
        emit();
      }).catch((failure) => {
        status = 'error';
        error = String(failure?.message ?? failure);
        emit();
      });
    },
  };
})();

/** Subscribe one component to the model catalog. */
function useCatalog() {
  return ReactRuntime.useSyncExternalStore(catalogStore.subscribe, catalogStore.get, catalogStore.get);
}

/** Read the last optimization failure, shared by the button and settings page. */
let lastFailure = null;
const failureListeners = new Set();
function setLastFailure(message) {
  lastFailure = message;
  for (const listener of [...failureListeners]) listener();
}
function useLastFailure() {
  return ReactRuntime.useSyncExternalStore(
    (listener) => {
      failureListeners.add(listener);
      return () => {
        failureListeners.delete(listener);
      };
    },
    () => lastFailure,
    () => lastFailure,
  );
}

/** The last reference outcome, shared by the button and the settings page. */
let lastReferenceResult = null;
const referenceResultListeners = new Set();
function setLastReferenceResult(result) {
  lastReferenceResult = result;
  for (const listener of [...referenceResultListeners]) listener();
}
function useLastReferenceResult() {
  return ReactRuntime.useSyncExternalStore(
    (listener) => {
      referenceResultListeners.add(listener);
      return () => {
        referenceResultListeners.delete(listener);
      };
    },
    () => lastReferenceResult,
    () => lastReferenceResult,
  );
}

/* ----------------------------------------------------------------- utilities */

/** Find one provider group by id. */
function findGroup(catalog, providerId) {
  return catalog?.groups?.find((group) => group.id === providerId);
}

/** Find one model entry inside a provider group. */
function findModel(group, modelId) {
  return group?.models?.find((model) => model.id === modelId);
}

/** Render a selection as `provider / model`. */
function modelName(catalog, selection) {
  const group = findGroup(catalog, selection.provider);
  const model = findModel(group, selection.model);
  return `${group?.name ?? selection.provider} / ${model?.name ?? selection.model}`;
}

/**
 * Read the selection the settings page shows.
 *
 * This mirrors the Host's `resolveRoute` priority, so the model named on the
 * page is the model the rewrite actually uses: stored pair while it is still in
 * the catalog, then the plugin's preferred vision model, then the deployment
 * default.
 *
 * @param catalog - live model catalog, or null while it loads.
 * @param settings - stored settings, or undefined while they load.
 * @returns `{ provider, model }`, or null when nothing is known.
 */
function effectiveSelection(catalog, settings) {
  if (settings === undefined || catalog === null) return null;
  if (settings.provider !== '' && settings.model !== '') {
    const stored = { provider: settings.provider, model: settings.model };
    if (findModel(findGroup(catalog, stored.provider), stored.model) !== undefined) return stored;
  }
  if (findModel(findGroup(catalog, PREFERRED_PROVIDER), PREFERRED_MODEL) !== undefined) {
    return { provider: PREFERRED_PROVIDER, model: PREFERRED_MODEL };
  }
  const fallback = catalog.default;
  if (fallback?.provider === undefined || fallback?.model === undefined) return null;
  return { provider: fallback.provider, model: fallback.model };
}

/** The label one reasoning effort shows in the picker. */
function effortName(reasoning, effort, t) {
  if (effort === '') return t('effort.default');
  const level = reasoning?.efforts?.find((candidate) => candidate.id === effort);
  return level?.name ?? effort;
}

/** Turn the Host's image status into a sentence, or undefined when silent. */
function imageNotice(t, result) {
  switch (result?.imageStatus) {
    case 'sent': return t('image.sent');
    case 'disabled': return t('image.disabled');
    case 'text-only': return t('image.textOnly');
    case 'no-store': return t('image.noStore');
    case 'failed': return t('image.failed');
    default: return undefined;
  }
}

/** Turn the Host's reference status into a sentence, or undefined when silent. */
function referenceTip(t, result) {
  if (!result) return undefined;
  const known = ['complete', 'none', 'partial', 'preserved', 'disabled'];
  return known.includes(result.status) ? t(`reference.${result.status}`, result) : undefined;
}

/**
 * The one-line success explanation shown in the button tooltip.
 *
 * Appended references are the most useful thing to report when they exist; an
 * image note is next, and "no relevant references" is the fallback when the
 * rewrite completed without either.
 */
function successDetail(t, body) {
  if (body.preserved || body.referenceStatus === 'preserved') return t('action.preserved');
  const result = {
    status: body.referenceStatus,
    files: Array.isArray(body.files) ? body.files.length : 0,
    skills: Array.isArray(body.skills) ? body.skills.length : 0,
  };
  const references = referenceTip(t, result);
  const image = imageNotice(t, body);
  if (result.status === 'complete' || result.status === 'partial') return references ?? image ?? t('action.done');
  if (image !== undefined) return image;
  if (result.status === 'none' || result.status === 'disabled') return references;
  return t('action.done');
}

/* ------------------------------------------------------------ composer seat */

/**
 * Resolve the composer's attached images into the wire shape the Host expects.
 *
 * The composer keeps draft attachments behind ids; `conversation` owns them and
 * is the only thing that can read the bytes. Only images travel: a file
 * attachment already rides along with the real send.
 *
 * The list is truncated to the plugin's own cap here, before the request is
 * serialized. The Host still validates the field, but a draft with five images
 * must degrade to "the first four" rather than failing the whole rewrite.
 *
 * @param ids - the composer's ordered draft attachment ids.
 * @returns `{ mediaType, data, name? }` entries, possibly empty.
 */
async function collectDraftImages(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const conversation = clientCtx?.get?.('conversation');
  if (conversation === undefined || typeof conversation.serializeDraftAttachments !== 'function') return [];
  try {
    const serialized = await conversation.serializeDraftAttachments(ids);
    return (serialized?.attachments ?? [])
      .filter((entry) => entry?.type === 'image' && typeof entry.data === 'string' && entry.data !== '')
      .slice(0, MAX_REQUEST_IMAGES)
      .map((entry) => ({
        mediaType: entry.mediaType,
        data: entry.data,
        ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * The optimize control beside the permission preset.
 *
 * It renders nothing while the draft is empty, becomes a spinner while the call
 * is in flight, and never submits. A successful reply replaces the whole draft
 * only when the draft, its revision, the session, and the component are all
 * still the ones the click started with.
 *
 * @param props - slot props: session id, composer state, and input actions.
 */
function OptimizeButton(props) {
  const { ref, sessionId, useInput, inputActions, t } = props;
  const draft = useInput((state) => state.draft);
  const phase = useInput((state) => state.phase);
  const draftRev = useInput((state) => state.draftRev);
  const attachmentIds = useInput((state) => state.attachmentIds);
  const [status, setStatus] = useState('idle');
  const [detail, setDetail] = useState('');
  /* Latest render values, read by the async callback after it awaited. */
  const latest = useRef(null);
  latest.current = { draft, draftRev, phase, sessionId };
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const hasText = typeof draft === 'string' && draft.trim() !== '';
  const busy = status === 'busy';
  /* A composer that is already committing a send must not be rewritten. */
  const locked = phase === 'adjudicating' || phase === 'submitting';

  /* Let the transient success/failure label fall back to the idle title. */
  useEffect(() => {
    if (status !== 'done' && status !== 'failed') return undefined;
    const timer = setTimeout(() => setStatus('idle'), status === 'failed' ? 3200 : 4200);
    return () => clearTimeout(timer);
  }, [status]);

  const run = async () => {
    if (running.current || busy || locked || !hasText) return;
    const text = draft;
    const revision = draftRev;
    const imageIds = Array.isArray(attachmentIds) ? [...attachmentIds] : [];
    running.current = true;
    setStatus('busy');
    setDetail('');
    try {
      /* Encoding is skipped entirely when the feature is off: a disabled toggle
         must not pay for base64 of an image the Host would discard anyway. */
      const images = imageIds.length === 0 || settingsStore.get().value?.includeImages === false
        ? []
        : await collectDraftImages(imageIds);
      const response = await fetch(RUN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, sessionId, ...(images.length === 0 ? {} : { images }) }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body === null || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      const current = latest.current;
      if (!mounted.current) return;
      /* Never clobber a draft the user replaced or submitted mid-flight. */
      if (current.draft !== text || current.draftRev !== revision
        || current.sessionId !== sessionId || current.phase === 'adjudicating' || current.phase === 'submitting') {
        setStatus('idle');
        return;
      }
      inputActions.setDraft(body.prompt);
      setLastFailure(null);
      const referenceResult = {
        status: body.referenceStatus,
        files: Array.isArray(body.files) ? body.files.length : 0,
        skills: Array.isArray(body.skills) ? body.skills.length : 0,
      };
      setLastReferenceResult(referenceResult);
      setDetail(successDetail(t, body));
      setStatus('done');
    } catch (error) {
      if (!mounted.current) return;
      const message = String(error?.message ?? error);
      setLastFailure(message);
      setDetail(t('action.failed', { message }));
      setStatus('failed');
      /* Surface the failure in the Host log too: the button has no room for it. */
      fetch(REPORT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      }).catch(() => {});
    } finally {
      running.current = false;
    }
  };

  if (!hasText && !busy) return null;

  const tip = busy
    ? t('action.busy')
    : status === 'failed' ? detail
      : status === 'done' ? detail
        : t('action.title');
  const label = busy
    ? t('action.labelBusy')
    : status === 'done' ? t('action.labelDone')
      : status === 'failed' ? t('action.labelFailed')
        : t('action.label');
  return ReactRuntime.createElement(Tooltip, {
    label: tip,
    side: 'top',
    delayMs: 400,
  }, ReactRuntime.createElement('button', {
    ref,
    type: 'button',
    className: 'OP-btn',
    'data-busy': busy ? 'true' : 'false',
    'data-failed': status === 'failed' ? 'true' : 'false',
    'data-done': status === 'done' ? 'true' : 'false',
    'aria-label': busy ? t('action.busy') : t('action.aria'),
    'aria-busy': busy ? 'true' : 'false',
    disabled: busy || locked,
    onMouseDown: (event) => event.preventDefault(),
    onClick: () => {
      run().catch(() => {});
    },
  }, [
    ReactRuntime.createElement(busy ? IconLoadingOutlineRegular : OptimizeSparkIcon, {
      key: 'icon',
      size: 15,
      className: busy ? 'OP-spin' : undefined,
      'aria-hidden': true,
    }),
    ReactRuntime.createElement('span', { key: 'label', className: 'OP-btnLabel' }, label),
  ]));
}

/* ---------------------------------------------------------------- pickers */

/**
 * One dropdown in the shipped menu idiom: a bordered value trigger and an
 * anchored panel of rows.
 *
 * The panel is plain markup rather than the shell's floating menu, because the
 * settings page scrolls and a fixed-position surface would detach from its
 * trigger. The query lives here so rows re-filter on every keystroke.
 */
function Picker(props) {
  const { label, ariaLabel, disabled, menuAriaLabel, searchPlaceholder, onSelect, children } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const choose = (key) => {
    setOpen(false);
    setQuery('');
    onSelect(key);
  };

  return ReactRuntime.createElement('div', { className: 'OP-picker', ref: root }, [
    ReactRuntime.createElement('button', {
      key: 'trigger',
      type: 'button',
      className: 'OP-pickerTrigger',
      disabled: disabled === true,
      'aria-label': ariaLabel,
      'aria-expanded': open,
      'aria-haspopup': 'listbox',
      onClick: () => setOpen((current) => !current),
    }, [
      ReactRuntime.createElement('span', { key: 'value', className: 'OP-pickerValue' }, label),
      ReactRuntime.createElement(IconChevronDownOutlineRegular, {
        key: 'chevron',
        size: 16,
        className: 'OP-pickerChevron',
        'data-open': open ? 'true' : 'false',
        'aria-hidden': true,
      }),
    ]),
    open ? ReactRuntime.createElement('div', {
      key: 'menu',
      className: 'OP-menu scrollable',
      role: 'listbox',
      'aria-label': menuAriaLabel ?? ariaLabel,
    }, [
      searchPlaceholder === undefined ? null : ReactRuntime.createElement('input', {
        key: 'search',
        type: 'search',
        className: 'OP-menuSearch',
        value: query,
        placeholder: searchPlaceholder,
        spellCheck: false,
        autoFocus: true,
        'aria-label': searchPlaceholder,
        onChange: (event) => setQuery(event.target.value),
      }),
      children(choose, query),
    ]) : null,
  ]);
}

/** One selectable row inside a picker panel. */
function PickerOption(props) {
  const { optionKey, selected, name, onSelect, disabled, hint } = props;
  return ReactRuntime.createElement('button', {
    type: 'button',
    role: 'option',
    className: 'OP-option',
    'data-key': optionKey,
    'aria-selected': selected === true,
    disabled: disabled === true,
    onClick: () => onSelect(),
  }, [
    ReactRuntime.createElement('span', { key: 'copy', className: 'OP-optionCopy' }, [
      ReactRuntime.createElement('span', { key: 'name' }, name),
      hint === undefined ? null : ReactRuntime.createElement('span', { key: 'hint', className: 'OP-menuHint' }, hint),
    ]),
    ReactRuntime.createElement('span', { key: 'check', className: 'OP-optionCheck' }, selected === true
      ? ReactRuntime.createElement(IconCheckOutlineRegular, { 'aria-hidden': true })
      : null),
  ]);
}

/** The live provider/model menu, used as the optimization model picker. */
function ModelPicker(props) {
  const { catalog, settings, t } = props;
  const groups = catalog.value?.groups ?? [];
  const used = effectiveSelection(catalog.value, settings);
  const currentName = used === null ? t('model.statusEmpty') : modelName(catalog.value, used);
  const showSearch = groups.reduce((total, group) => total + group.models.length, 0) > 8;

  return ReactRuntime.createElement(Picker, {
    label: currentName,
    ariaLabel: t('model.aria', { name: currentName }),
    menuAriaLabel: t('model.listAria'),
    searchPlaceholder: showSearch ? t('model.search') : undefined,
    disabled: groups.length === 0 || settings === undefined,
    onSelect: (key) => {
      const separator = key.indexOf('\u0000');
      if (separator < 0) return;
      /* Changing the model clears the effort: the new model's levels are its own. */
      settingsStore.patch({
        provider: key.slice(0, separator),
        model: key.slice(separator + 1),
        reasoningEffort: '',
      });
    },
  }, (choose, query) => {
    const needle = query.trim().toLowerCase();
    const matches = (text) => needle === '' || String(text).toLowerCase().includes(needle);
    const visibleGroups = groups
      .map((group) => ({
        group,
        models: group.models.filter((model) => matches(model.name ?? model.id)
          || matches(model.id)
          || matches(group.name ?? group.id)),
      }))
      .filter((entry) => entry.models.length > 0);
    return [
      ...visibleGroups.map(({ group, models }) => ReactRuntime.createElement('div', {
        key: group.id,
        className: 'OP-menuRow',
      }, [
        ReactRuntime.createElement('div', { key: 'label', className: 'OP-groupLabel' }, group.name ?? group.id),
        ...models.map((model) => ReactRuntime.createElement(PickerOption, {
          key: `${group.id}\u0000${model.id}`,
          optionKey: `${group.id}\u0000${model.id}`,
          selected: used !== null && used.provider === group.id && used.model === model.id,
          name: model.name ?? model.id,
          hint: model.description,
          onSelect: () => choose(`${group.id}\u0000${model.id}`),
        })),
      ])),
      needle !== '' && visibleGroups.length === 0
        ? ReactRuntime.createElement('div', { key: 'empty', className: 'OP-menuEmpty' }, t('model.empty'))
        : null,
    ];
  });
}

/* ------------------------------------------------------------- settings page */

/** One labelled card with an explanatory hint. */
function Section(props) {
  return ReactRuntime.createElement('section', { className: 'OP-card' }, [
    ReactRuntime.createElement('h3', { key: 'h' }, props.title),
    props.children,
    props.hint === undefined ? null : ReactRuntime.createElement('p', { key: 'p', className: 'OP-hint' }, props.hint),
  ]);
}

/**
 * One on/off preference row.
 *
 * The control is a real `role="switch"` button with `aria-checked`, so it is
 * reachable and legible to assistive technology without a second checkbox style.
 */
function Toggle(props) {
  const { label, hint, checked, disabled, onLabel, offLabel, onChange } = props;
  return ReactRuntime.createElement('div', { className: 'OP-toggle' }, [
    ReactRuntime.createElement('div', { key: 'copy', className: 'OP-toggleCopy' }, [
      ReactRuntime.createElement('span', { key: 'label', className: 'OP-toggleLabel' }, label),
      hint === undefined ? null : ReactRuntime.createElement('span', { key: 'hint', className: 'OP-hint' }, hint),
    ]),
    ReactRuntime.createElement('button', {
      key: 'switch',
      type: 'button',
      role: 'switch',
      className: 'OP-switch',
      'aria-checked': checked === true,
      'aria-label': label,
      disabled: disabled === true,
      'data-on': checked === true ? 'true' : 'false',
      onClick: () => onChange(checked !== true),
    }, [
      ReactRuntime.createElement('span', { key: 'track', className: 'OP-switchTrack' }, [
        ReactRuntime.createElement('span', { key: 'thumb', className: 'OP-switchThumb' }),
      ]),
      ReactRuntime.createElement('span', { key: 'state', className: 'OP-switchState' },
        checked === true ? onLabel : offLabel),
    ]),
  ]);
}

/**
 * The skill-reference tier: how willing the rewrite should be to pick a skill.
 *
 * `off` is one of the tiers, which is why this is a dropdown rather than a
 * second switch. The tier changes the wording the model receives; every tier
 * still goes through the same catalog validation.
 */
function SkillModePicker(props) {
  const { settings, t } = props;
  const tiers = ['strict', 'balanced', 'eager'];
  /* The Host normalizes the stored value, so anything unknown here is a page
     rendered before the settings arrived; it shows the default in that window. */
  const current = tiers.includes(settings?.skillMode) || settings?.skillMode === 'off'
    ? settings.skillMode
    : 'balanced';
  return ReactRuntime.createElement('div', { className: 'OP-toggle' }, [
    ReactRuntime.createElement('div', { key: 'copy', className: 'OP-toggleCopy' }, [
      ReactRuntime.createElement('span', { key: 'label', className: 'OP-toggleLabel' }, t('reference.skills')),
      ReactRuntime.createElement('span', { key: 'hint', className: 'OP-hint' }, t(`reference.skillMode.${current}Hint`)),
    ]),
    ReactRuntime.createElement('div', { key: 'picker', className: 'OP-togglePicker' },
      ReactRuntime.createElement(Picker, {
        label: t(`reference.skillMode.${current}`),
        ariaLabel: t('reference.skills'),
        menuAriaLabel: t('reference.skills'),
        disabled: settings === undefined,
        onSelect: (key) => settingsStore.patch({ skillMode: key }),
      }, (choose) => ReactRuntime.createElement('div', { className: 'OP-menuRow' }, [
        ...['off', ...tiers].map((mode) => ReactRuntime.createElement(PickerOption, {
          key: mode,
          optionKey: mode,
          selected: current === mode,
          name: t(`reference.skillMode.${mode}`),
          hint: t(`reference.skillMode.${mode}Hint`),
          onSelect: () => choose(mode),
        })),
      ]))),
  ]);
}

/** The plugin settings page. */
function SettingsPage(props) {
  const t = props.t;
  const settings = useSettings();
  const catalog = useCatalog();
  const used = effectiveSelection(catalog.value, settings);
  const failure = useLastFailure();
  const referenceResult = useLastReferenceResult();
  const [promptDraft, setPromptDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  const settled = useRef(false);
  const saving = settingsStore.saving();

  useEffect(() => {
    settingsStore.ensure();
    catalogStore.ensure(clientCtx);
  }, []);

  useEffect(() => {
    if (settings === undefined) return undefined;
    if (saving || settingsStore.error() !== null) {
      setSaved(false);
      return undefined;
    }
    /* The first settle is the initial load, not a save. */
    if (!settled.current) {
      settled.current = true;
      return undefined;
    }
    setSaved(true);
    const timer = setTimeout(() => setSaved(false), 1400);
    return () => clearTimeout(timer);
  }, [settings, saving]);

  const reasoning = used === null
    ? undefined
    : findModel(findGroup(catalog.value, used.provider), used.model)?.reasoning;
  const prompt = promptDraft ?? settings?.systemPrompt ?? '';
  const error = settingsStore.error();

  return ReactRuntime.createElement('div', { className: 'OP-page' }, [
    ReactRuntime.createElement('p', { key: 'intro', className: 'OP-intro' }, t('intro')),

    ReactRuntime.createElement(Section, {
      key: 'model',
      title: t('model.heading'),
      hint: t('model.hint'),
    }, [
      catalog.status === 'loading'
        ? ReactRuntime.createElement('p', { key: 'loading', className: 'OP-hint' }, t('model.statusLoading'))
        : null,
      catalog.status === 'error'
        ? ReactRuntime.createElement('p', { key: 'error', className: 'OP-error' }, t('model.statusError', { message: catalog.error }))
        : null,
      ReactRuntime.createElement(ModelPicker, {
        key: 'picker',
        catalog,
        settings,
        t,
      }),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'effort',
      title: t('effort.heading'),
      hint: reasoning === undefined ? t('effort.unsupported') : t('effort.hint'),
    }, [
      ReactRuntime.createElement(Picker, {
        key: 'picker',
        label: effortName(reasoning, settings?.reasoningEffort ?? '', t),
        ariaLabel: t('effort.heading'),
        menuAriaLabel: t('effort.heading'),
        disabled: reasoning === undefined || settings === undefined,
        onSelect: (key) => settingsStore.patch({ reasoningEffort: key }),
      }, (choose) => ReactRuntime.createElement('div', { className: 'OP-menuRow' }, [
        ReactRuntime.createElement(PickerOption, {
          key: 'default',
          optionKey: '',
          selected: (settings?.reasoningEffort ?? '') === '',
          name: t('effort.default'),
          onSelect: () => choose(''),
        }),
        ...(reasoning?.efforts ?? []).map((level) => ReactRuntime.createElement(PickerOption, {
          key: level.id,
          optionKey: level.id,
          selected: settings?.reasoningEffort === level.id,
          name: level.name,
          hint: level.description,
          onSelect: () => choose(level.id),
        })),
      ])),
      ReactRuntime.createElement('p', { key: 'note', className: 'OP-hint' }, t('effort.followUp')),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'reference',
      title: t('reference.heading'),
      hint: t('reference.hint'),
    }, [
      ReactRuntime.createElement(Toggle, {
        key: 'files',
        label: t('reference.files'),
        hint: t('reference.filesHint'),
        checked: settings?.referenceFiles !== false,
        disabled: settings === undefined,
        onLabel: t('toggle.on'),
        offLabel: t('toggle.off'),
        onChange: (next) => settingsStore.patch({ referenceFiles: next }),
      }),
      ReactRuntime.createElement(SkillModePicker, {
        key: 'skills',
        settings,
        t,
      }),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'images',
      title: t('images.heading'),
      hint: t('images.hint'),
    }, [
      ReactRuntime.createElement(Toggle, {
        key: 'toggle',
        label: t('images.toggle'),
        hint: t('images.toggleHint'),
        checked: settings?.includeImages !== false,
        disabled: settings === undefined,
        onLabel: t('toggle.on'),
        offLabel: t('toggle.off'),
        onChange: (next) => settingsStore.patch({ includeImages: next }),
      }),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'prompt',
      title: t('prompt.heading'),
      hint: t('prompt.hint'),
    }, [
      ReactRuntime.createElement('div', { key: 'head', className: 'OP-head' }, [
        ReactRuntime.createElement('span', {
          key: 'status',
          className: 'OP-status',
          'data-tone': error === null ? 'ok' : 'error',
        }, error === null
          ? (saving ? t('status.saving') : saved ? t('status.saved') : '')
          : t('status.failed', { message: error })),
        ReactRuntime.createElement('button', {
          key: 'reset',
          type: 'button',
          className: 'OP-ghost',
          disabled: settings === undefined,
          onClick: () => {
            setPromptDraft(null);
            settingsStore.patch({ systemPrompt: '' });
          },
        }, t('prompt.reset')),
      ]),
      ReactRuntime.createElement('textarea', {
        key: 'textarea',
        className: 'OP-textarea',
        value: prompt,
        spellCheck: false,
        disabled: settings === undefined,
        'aria-label': t('prompt.heading'),
        onChange: (event) => setPromptDraft(event.target.value),
        onBlur: () => {
          if (promptDraft === null) return;
          setPromptDraft(null);
          settingsStore.patch({ systemPrompt: promptDraft });
        },
      }),
    ]),

    referenceTip(t, referenceResult) === undefined ? null : ReactRuntime.createElement(Section, {
      key: 'last-reference-result',
      title: t('reference.statusHeading'),
    }, ReactRuntime.createElement('p', { className: 'OP-hint', role: 'status' }, referenceTip(t, referenceResult))),

    failure === null ? null : ReactRuntime.createElement(Section, {
      key: 'last-error',
      title: t('lastError.heading'),
    }, ReactRuntime.createElement('p', { className: 'OP-error' }, failure)),

    ReactRuntime.createElement(Section, {
      key: 'about',
      title: t('about.heading'),
    }, ReactRuntime.createElement('p', { className: 'OP-hint' }, t('about.body', { version: PLUGIN_VERSION }))),
  ]);
}

/* ------------------------------------------------------------------- apply */

/**
 * The context `apply` ran with. Slot components cannot import it, so the
 * settings page reads the Remote namespace from here.
 */
let clientCtx = null;

/**
 * Client plugin body.
 *
 * @param ctx - the plugin context.
 */
function apply(ctx) {
  clientCtx = ctx;
  ctx.effect(() => ensureStyleTag(), `${PACKAGE_NAME}: stylesheet`);

  const t = ctx.locale.bind(NS);
  ctx.locale.register(NS, 'zh', zh);
  ctx.locale.register(NS, 'en', en);

  /* The permission preset ("工作区内修改") is a single slot owned by DSH. The
     adjacent list slot is the supported place to sit beside it without
     overriding shipped UI. */
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PACKAGE_NAME,
    order: 20,
    locale: NS,
    inject: (sessionId) => ({ sessionId }),
  }, OptimizeButton));

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PACKAGE_NAME,
    order: 40,
    label: () => t('nav'),
    locale: NS,
  }, SettingsPage));
}

export { apply, inject };
