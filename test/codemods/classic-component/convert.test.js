import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { convertComponents } from "#codemods/classic-component/convert.js";

/**
 * @param {string} name
 */
function fixture(name) {
  return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
}

/**
 * From emberobserver/client, with emberx-select 3.1.1 (MIT) in the app, where the inline stage moves it.
 */
test("ember-observer's svg-icon and emberx-select", () => {
  let sources = new Map([
    [
      "app/components/svg-icon.js",
      `/* eslint-disable ember/no-classic-classes */
import Component from '@ember/component';

export default Component.extend({
  tagName: '',
  alignBaseline: true,
}).reopenClass({
  positionalParams: ['iconName'],
});
`,
    ],
    [
      "app/components/svg-icon.hbs",
      `<svg class="icon icon-{{this.iconName}} {{if this.alignBaseline 'baseline'}} {{this.class}}"><title>{{this.title}}</title><use xlink:href="#icon-{{this.iconName}}"></use></svg>\n`,
    ],
    ["app/components/x-select.js", fixture("x-select.js.txt")],
    ["app/components/x-select.hbs", fixture("x-select.hbs.txt")],
    ["app/components/x-option.js", fixture("x-option.js.txt")],
    [
      "app/components/category-position-dropdown.hbs",
      `<XSelect @value={{this.position}} @action={{this.updatePosition}} as |xs|>
  <xs.option @value={{-1}}>At end</xs.option>
</XSelect>
{{svg-icon "close" alignBaseline=false class="test-close"}}
`,
    ],
  ]);

  let result = convertComponents(sources);

  expect(result.skipped).toEqual([]);
  expect(Array.from(result.packages)).toEqual(["ember-modifier"]);
  expect(Object.fromEntries(result.files)).toMatchInlineSnapshot(`
    {
      "app/components/category-position-dropdown.hbs": "<XSelect @value={{this.position}} @action={{this.updatePosition}} as |xs|>
      <xs.option @value={{-1}}>At end</xs.option>
    </XSelect>
    <SvgIcon @iconName="close" @alignBaseline={{false}} @class="test-close" />
    ",
      "app/components/svg-icon.hbs": "<svg class="icon icon-{{@iconName}} {{if this.alignBaseline 'baseline'}} {{@class}}"><title>{{@title}}</title><use xlink:href="#icon-{{@iconName}}"></use></svg>
    ",
      "app/components/svg-icon.js": "/* eslint-disable ember/no-classic-classes */
    import Component from '@glimmer/component';

    export default class SvgIcon extends Component {
      get alignBaseline() {
        return this.args.alignBaseline ?? true;
      }
    }
    ",
      "app/components/x-option.hbs": "<option class="x-option" selected={{this.selected}} name={{@name}} disabled={{@disabled}} value={{this.value}} title={{@title}} ...attributes {{this.lifecycle}}>
    {{this.didReceiveAttrs @value @disabled @register @unregister @name @title @select}}
    {{yield}}
    </option>
    ",
      "app/components/x-option.js": "import { scheduleOnce } from '@ember/runloop';
    import { get, action } from '@ember/object';
    import Component from '@glimmer/component';
    import { isArray, A } from '@ember/array';
    import { modifier } from 'ember-modifier';

    /**
     * Used to wrap a native \`<option>\` tag and associate an object with
     * it that can be bound. It can only be used in conjuction with a
     * containing \`x-select\` component
     *
     * @class Ember.XOptionComponent
     * @extends Ember.Component
     */
    export default class XOption extends Component {
      element = null;

      lifecycle = modifier((element) => {
        this.element = element;
        this.didInsertElement();

        return () => {
          this.willDestroyElement();
          this.element = null;
        };
      });

      get disabled() {
        return this.args.disabled;
      }

      get "on-disable"() {
        return this.args["on-disable"];
      }

      get register() {
        return this.args.register;
      }

      get unregister() {
        return this.args.unregister;
      }

      get name() {
        return this.args.name;
      }

      get title() {
        return this.args.title;
      }

      get select() {
        return this.args.select;
      }

      _oldDisabled;

      /**
       * The value associated with this option. When this option is
       * selected, the \`x-select\` will fire its action with this
       * value.
       *
       * @property value
       * @type Object
       * @default null
       */
      get value() {
        return this.args.value;
      }

      /**
       * Property bound to the \`selected\` attribute of the native
       * \`<option>\` element. It is aware of the containing \`x-select\`'s
       * value and will mark itself if it is the same.
       *
       * @private
       * @property selected
       * @type Boolean
       */
      get selected() {
        if (get(this.args, 'select.multiple') && isArray(get(this.args, 'select.value'))) {
          let selectValue = A(get(this.args, 'select.value'));

          return selectValue.includes(this.value);
        } else {
          return this.value === get(this.args, 'select.value');
        }
      }

      @action
      didReceiveAttrs() {
        let oldDisabled = this._oldDisabled;

        if(oldDisabled !== undefined && !oldDisabled) {
          // Undefined means the first time

          if(this.disabled !== oldDisabled) {
            this["on-disable"]?.(this.value, this.disabled);
          }
        }

        this._oldDisabled = this.disabled;
      }

      /**
       * Register this x-option with the containing \`x-select\`
       *
       * @override
       */
      didInsertElement() {
        scheduleOnce('afterRender', () => {
          this.register(this);
        });
      }

      /**
       * Unregister this x-option with its containing x-select.
       *
       * @override
       */
      willDestroyElement() {
        this.unregister(this);
      }
    }
    ",
      "app/components/x-select.hbs": "<select class="x-select" disabled={{this.disabled}} tabindex={{this.tabindex}} multiple={{this.multiple}} form={{@form}} name={{@name}} autofocus={{@autofocus}} required={{@required}} size={{@size}} title={{@title}} ...attributes {{on "change" this.change}} {{on "click" this.click}} {{on "focusout" this.focusOut}} {{this.lifecycle}}>
    {{this.ensureProperType @value}}
    {{yield
      (hash
        option=(component "x-option" select=this register=this.registerOption unregister=this.unregisterOption)
      )
    }}
    </select>
    ",
      "app/components/x-select.js": "import { once } from '@ember/runloop';
    import { warn } from '@ember/debug';
    import Component from '@glimmer/component';
    import { isArray, A } from '@ember/array';
    import { get, action } from '@ember/object';
    import { cached } from '@glimmer/tracking';
    import { modifier } from 'ember-modifier';

    const isSelectedOption = (option) => option.element.matches(':checked');

    /**
     * Wraps a native <select> element so that it can be object and
     * binding aware. It is used in conjuction with the
     * \`x-option\` component to construct select boxes. E.g.
     *
     *   {{#x-select value="bob" action="selectPerson"}}
     *     {{x-option value="fred"}}Fred Flintstone{{/x-option}}
     *     {{x-option value="bob"}}Bob Newhart{{/x-option}}
     *   {{/x-select}}
     *
     * the options are always up to date, so that when the object bound to
     * \`value\` changes, the corresponding option becomes selected.
     *
     * Whenever the select tag receives a change event, it will fire
     * \`action\`
     *
     * @class Ember.XSelectComponent
     * @extends Ember.Component
     */
    export default class XSelect extends Component {
      element = null;

      lifecycle = modifier((element) => {
        this.element = element;
        this.didInsertElement();

        return () => {
          this.willDestroyElement();
          this.element = null;
        };
      });

      get action() {
        return this.args.action;
      }

      get value() {
        return this.args.value;
      }

      get form() {
        return this.args.form;
      }

      get name() {
        return this.args.name;
      }

      get autofocus() {
        return this.args.autofocus;
      }

      get required() {
        return this.args.required;
      }

      get size() {
        return this.args.size;
      }

      get title() {
        return this.args.title;
      }

      /**
       * Bound to the \`disabled\` attribute on the native <select> tag.
       *
       * @property disabled
       * @type Boolean
       * @default false
       */
      disabled = false;

      /**
       * Bound to the \`multiple\` attribute on the native <select> tag.
       *
       * @property multiple
       * @type Boolean
       * @default false
       */
      multiple = false;

      /**
       * The collection of options for this select box. When options are
       * rendered as a child from x-select, they will register themselves with their
       * containing \`x-select\`. This is for internal book-keeping only and should
       * not be changed from outside.
       *
       * @private
       * @property options
       */
      @cached
      get options() {
        return A([]);
      }

      /**
       * Bound to the \`tabindex\` attribute on the native <select> tag.
       *
       * @property tabindex
       * @type Integer
       * @default 0
       */
      tabindex = 0;

      /**
       * Function for the \`on-blur\` action
       *
       * @property on-blur
       * @type Function
       */
      "on-blur"() {}

      /**
       * Function for the \`on-click\` action
       *
       * @property on-click
       * @type Function
       */
      "on-click"() {}

      /**
       * Function for the \`on-change\` action
       *
       * @property on-change
       * @type Function
       */
      "on-change"() {}

      /**
       * Function for the \`on-focus-out\` action
       *
       * @property on-focus-out
       * @type Function
       */
      "on-focus-out"() {}

      /**
       * Function that calls an action and sends the proper arguments.
       *
       * @method _handleAction
       * @type Function
       * @param {String} action - string name of the action to invoke
       * @param {String|Object} value - current value of the component
       * @param {Object} event - jQuery event from the current action
       */
      _handleAction(action, value, event) {
        let actionValue = get(this, action);

        if(typeof actionValue === 'string') {
          warn(\`x-select: You must use the action helper for all actions. The try: \${action}=(action "\${actionValue}") in your template\`, false, {id: 'x-select-string-action'});
          return;
        }

        get(this, action)(value, event);
      }

      /**
       * When the select DOM event fires on the element, trigger the
       * component's action with the current value.
       */
      @action
      change(event) {
        let nextValue = this._getValue();

        this.action?.(nextValue, event, this);
        this._handleAction('on-change', nextValue, event);
      }

      /**
       * When the click DOM event fires on the element, trigger the
       * component's action with the component, x-select value, and the jQuery event.
       */
      @action
      click(event) {
        this._handleAction('on-click', this._getValue(), event);
      }

      /**
       * When the blur DOM event fires on the element, trigger the
       * component's action with the component, x-select value, and the jQuery event.
       */
      blur(event) {
        this._handleAction('on-blur', this._getValue(), event);
      }

      /**
       * When the focusOut DOM event fires on the element, trigger the
       * component's action with the component, x-select value, and the jQuery event.
       */
      @action
      focusOut(event) {
        this._handleAction('on-focus-out', this._getValue(), event);
      }

      /**
       * Reads the current selection from this select's options.
       *
       * If this is a multi-select, then the value will be an
       * array. Otherwise, it will be a single value which could be null.
       *
       * @private
       * @return {Array|Object} the current selection
       */
      _getValue() {
        return this.multiple ? this._findMultipleValues() : this._findSingleValue();
      }

      /**
       * Finds all selected values from all \`x-option\`
       * children. Used when this.get('multiple') === true
       *
       * @private
       * @return {Array} all the values from selected x-options
       */
      _findMultipleValues() {
        return this.options.filter(isSelectedOption).map(option => get(option, 'value'));
      }

      /**
       * Returns the value of the first selected \`x-option\`.
       * Used when \`this.get('multiple') !== true\`
       *
       * @private
       * @return {Object} the value of the first select \`x-option\`, or null
       */
      _findSingleValue() {
        let selectedValue = this.options.find(isSelectedOption);
        return selectedValue ? get(selectedValue, 'value') : null;
      }

      /**
       * If no explicit value is set, apply default values based on selected=true in
       * the template.
       *
       * @private
       */
      _setDefaultValues() {
        once(this, this.__setDefaultValues);
      }

      __setDefaultValues() {
        let canSet = !this.isDestroying && !this.isDestroyed;
        if (canSet && this.value == null) {
          this.action?.(this._getValue());
        }
      }

      /**
       * @override
       */
      didInsertElement() {
        this.element.addEventListener('blur', (event) => {
          this.blur(event);
        });

        // FIXME this is an unfortunate workaround for an Edge bug for selects with required:
        // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/8794503/
        if (/edge\\//i.test(window.navigator.userAgent)) {
          let value = this.element.value;
          this.element.value = \`\${value}-fake-edge-😳\`;
          this.element.value = value;
        }
      }

      /**
       * @override
       */
      willDestroyElement() {
      }

      /**
       * If this is a multi-select, and the value is not an array, that
       * probably indicates a misconfiguration somewhere, so we error out.
       *
       * @private
       */
      @action
      ensureProperType() {
        let value = this.value;

        if (value != null && this.multiple && !isArray(value)) {
          throw new Error(\`x-select multiple=true was set, but value \${value} is not enumerable.\`);
        }
      }

      /**
       * Registers a new option that is contained within x-select.
       *
       * This is called whenever an x-option component is inserted into the DOM.
       *
       * @param {<x-option>} option - x-option component.
       * @private
       */
      @action
      registerOption(option) {
        this.options.push(option);
        this._setDefaultValues();
      }

      /**
       * Removes a the passed option that is contained within x-select.
       *
       * This is called whenever an x-option component is begining teardown.
       *
       * @param {<x-option>} option - x-option component.
       * @private
       */
      @action
      unregisterOption(option) {
        this.options.removeObject(option);
        this._setDefaultValues();
      }
    }
    ",
    }
  `);
});
