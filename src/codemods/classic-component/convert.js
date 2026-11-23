import { rewriteAccessors } from "./accessors.js";
import { classifyNames } from "./args.js";
import { rewriteCallers } from "./callers.js";
import { toGlimmer } from "./glimmer.js";
import { findInvocations } from "./invocations.js";
import { rewriteJQuery } from "./jquery.js";
import { inlineMixins } from "./mixins.js";
import { rewriteKeyboard } from "./keyboard.js";
import { rewritePrototypeExtensions } from "./prototype-extensions.js";
import { readClassicComponent } from "./read.js";
import { needsActionHandler, needsActionValue, rewriteTemplate } from "./template.js";
import { classUsage, templateUsage } from "./usage.js";

/** @typedef {import('./callers.js').Converted} Converted */
/** @typedef {import('./mixins.js').Resolve} Resolve */

/**
 * @typedef {object} Candidate
 * @property {string} name such as `admin/review-form`
 * @property {string} file
 * @property {string} templateFile
 * @property {string} source
 */

/**
 * @typedef {object} Conversion
 * @property {Map<string, string>} files the new contents of each file that changed
 * @property {{ file: string, reasons: string[] }[]} skipped the classic components that stay, and why
 * @property {Set<string>} packages the packages that the new code imports, such as `ember-modifier`
 */

/**
 * @param {string} file such as `app/components/admin/review-form.js`
 * @returns {string | undefined} the component's name, such as `admin/review-form`
 */
export function componentName(file) {
  let match = /^app\/components\/(.+)\.(js|ts)$/.exec(file);

  if (!match?.[1]) return;

  return match[1].replace(/\/index$/, "");
}

/**
 * The hooks that run when the element goes away.
 */
const TEARDOWN = new Set(["willDestroyElement", "willClearRender"]);

/**
 * @param {Candidate} candidate
 * @param {string} template
 * @param {Map<string, string>} templates every template of the app, to find the arguments that callers pass
 * @param {Resolve} resolve
 */
function analyze(candidate, template, templates, resolve) {
  let keyboard = rewriteKeyboard(candidate.source, candidate.file);
  let mixins = inlineMixins(keyboard, candidate.file, resolve);
  let extensions = rewritePrototypeExtensions(mixins.source, candidate.file);
  let jquery = rewriteJQuery(extensions, candidate.file, TEARDOWN);
  let accessors = rewriteAccessors(jquery.source, candidate.file);

  if (!accessors) return;

  let component = readClassicComponent(accessors.source, candidate.file);

  if (!component) return;

  /** @type {Set<string>} */
  let passed = new Set();
  let open = false;

  for (let other of templates.values()) {
    for (let invocation of findInvocations(other, candidate.name)) {
      for (let name of invocation.named) passed.add(name);

      if (invocation.kind === "component" && invocation.node.type === "GlimmerSubExpression") {
        open = true;
      }
    }
  }

  let fromClass = classUsage(component.node);
  let fromTemplate = templateUsage(template);
  let reads = new Set(fromClass.reads);
  let writes = new Set(fromClass.writes);

  for (let key of fromTemplate.reads) reads.add(key);

  /**
   * The bindings of the element read the component's properties in the new template.
   */
  let outer = component.outerHtml;

  for (let binding of outer.attributeBindings.concat(outer.classNameBindings)) {
    let key = binding.split(":")[0]?.split(".")[0];

    if (key) {
      reads.add(key);
      fromTemplate.reads.add(key);
    }
  }
  for (let key of fromTemplate.writes) writes.add(key);
  for (let key of accessors.sets) writes.add(key);

  /**
   * The `on-key` helper in the new template reads the keyboard properties.
   */
  if (keyboard !== candidate.source) {
    for (let key of ["keyboardActivated", "keyboardPriority"]) {
      if (key === "keyboardPriority" && !passed.has(key)) continue;

      reads.add(key);
      fromTemplate.reads.add(key);
    }
  }

  let names = classifyNames(component, {
    passed,
    reads,
    writes,
    templateReads: fromTemplate.reads,
    members: new Map(component.members.map((member) => [member.name, classUsage(member.node)])),
    open,
    leaks: fromClass.leaks || fromTemplate.leaks,
  });
  let glimmer = toGlimmer(accessors.source, candidate.file, names, {
    templateReads: fromTemplate.reads,
    imports: accessors.imports,
    actionHandler: needsActionHandler(template, component),
    actionValue: needsActionValue(template),
  });

  for (let reason of mixins.unreadable) glimmer.unreadable.push(reason);
  for (let reason of jquery.unreadable) glimmer.unreadable.push(reason);

  return { component, names, glimmer };
}

/**
 * Converts the classic components of an app into Glimmer components,
 * and rewrites the templates that invoke them.
 *
 * @param {Map<string, string>} sources the app's component modules and templates, by path
 * @param {{ resolve?: Resolve }} [options] `resolve` finds the app's mixins that the components use
 * @returns {Conversion}
 */
export function convertComponents(sources, options = {}) {
  let resolve = options.resolve ?? (() => undefined);
  /** @type {Conversion} */
  let result = { files: new Map(), skipped: [], packages: new Set() };
  /** @type {Map<string, string>} */
  let templates = new Map(Array.from(sources).filter(([file]) => file.endsWith(".hbs")));
  /** @type {Candidate[]} */
  let candidates = [];

  for (let [file, source] of sources) {
    let name = componentName(file);

    if (!name || file.endsWith(".d.ts")) continue;
    if (!/@ember\/component['"]/.test(source)) continue;
    if (!readClassicComponent(source, file)) continue;

    candidates.push({ name, file, templateFile: file.replace(/\.(js|ts)$/, ".hbs"), source });
  }

  let templateOf = (/** @type {Candidate} */ candidate) =>
    templates.get(candidate.templateFile) ?? "{{yield}}\n";

  /**
   * A caller's new `(mut this.x)` can make one of its own arguments a callback too,
   * so the analysis runs again until no template changes.
   */
  for (let round = 0; round < 4; round++) {
    /** @type {Map<string, Converted>} */
    let converted = new Map();

    for (let candidate of candidates) {
      let analysis = analyze(candidate, templateOf(candidate), templates, resolve);

      if (!analysis || analysis.glimmer.unreadable.length > 0) continue;

      converted.set(candidate.name, {
        positionalParams: analysis.component.positionalParams,
        hasElement: analysis.component.outerHtml.tagName !== "",
        callbacks: analysis.names.callbacks,
      });
    }

    let changed = false;

    for (let [file, template] of templates) {
      let callers = rewriteCallers(template, converted);

      if (callers.template !== template) {
        templates.set(file, callers.template);
        changed = true;
      }
    }

    if (!changed) break;
  }

  for (let candidate of candidates) {
    let template = templateOf(candidate);
    let analysis = analyze(candidate, template, templates, resolve);
    let reasons = analysis ? analysis.glimmer.unreadable.slice() : ["does not parse"];

    if (!analysis || reasons.length > 0) {
      result.skipped.push({ file: candidate.file, reasons });
      continue;
    }

    let rewritten = rewriteTemplate(template, analysis.component, analysis.names, analysis.glimmer);

    if (rewritten.unreadable.length > 0) {
      result.skipped.push({ file: candidate.file, reasons: rewritten.unreadable });
      continue;
    }

    if (analysis.glimmer.modifier) result.packages.add("ember-modifier");

    result.files.set(candidate.file, analysis.glimmer.source);
    templates.set(candidate.templateFile, rewritten.template);
    result.files.set(candidate.templateFile, rewritten.template);
  }

  for (let [file, template] of templates) {
    if (template !== sources.get(file) && !result.files.has(file)) {
      result.files.set(file, template);
    }
  }

  return result;
}
