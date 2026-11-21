import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { addVitePlugin } from "#config-files.js";
import { Project } from "#project.js";
import {
  plan,
  removeOption,
  removeStyleImports,
  undefinedVariables,
} from "#stages/ember-css-modules/index.js";
import {
  compositions,
  definitionsOnly,
  topLevel,
  unwrapGlobal,
  wrapBareGlobal,
} from "#stages/ember-css-modules/styles.js";
import { rewriteTemplate } from "#stages/ember-css-modules/templates.js";
import emberScopedCss, {
  addTemplateTransform,
  additionalRoots,
} from "#stages/ember-css-modules/vite.js";

/**
 * @param {Record<string, string>} files
 */
function project(files) {
  let directory = mkdtempSync(join(tmpdir(), "ember-upgrade-"));

  for (let [file, contents] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }

  return new Project(directory);
}

/**
 * The files below are from CenterForOpenScience/ember-osf-web, some of them shortened.
 */
const SORT_BUTTON_TEMPLATE = `<Button
    data-test-ascending-sort={{this.sortBy}}
    data-analytics-name={{concat 'Ascending sort ' this.sortBy}}
    local-class={{if (eq @sort this.sortBy) 'selected' 'not-selected'}}
    title={{t 'general.sort_asc'}}
    {{on 'click' (action @sortAction this.sortBy)}}
>
    <FaIcon @icon='chevron-up' />
</Button>
`;

const SORT_BUTTON_STYLES = `// stylelint-disable selector-class-pattern
.SortButton {
    padding-left: 10px;
    display: table-cell;

    :global(.btn) {
        &:active {
            box-shadow: none;
        }
    }

    .selected {
        color: $color-text-blue-dark !important;
    }
}
`;

const SORT_BUTTON_COMPONENT = `import { tagName } from '@ember-decorators/component';
import Component from '@ember/component';
import { localClassNames } from 'ember-css-modules';

import { layout } from 'ember-osf-web/decorators/component';

import styles from './styles';
import template from './template';

@layout(template, styles)
@tagName('span')
@localClassNames('SortButton')
export default class SortButton extends Component {
}
`;

const BUILD = `const EmberApp = require('ember-cli/lib/broccoli/ember-app');

module.exports = function(defaults) {
    const app = new EmberApp(defaults, {
        sassOptions: {
            includePaths: [
                'app/styles/',
            ],
        },
        cssModules: {
            headerModules: [
                'ember-osf-web/styles/headers',
            ],
        },
        babel: {
            sourceMaps: 'inline',
        },
    });

    return app.toTree();
};
`;

const HEADERS = `// Variable up top to override properly with SASS
@import 'variables';

// 3rd parties
@import 'ember-power-select';

.osf-selected {
    background-color: $color-select;
    color: #fff;
}
`;

const VARIABLES = `// Bootstrap Variables
$color-select: #e6f6fc;
$color-text-blue-dark: #337ab7;
`;

const REGISTRIES_INDEX = `/* eslint-env node */

const EngineAddon = require('ember-engines/lib/engine-addon');

module.exports = EngineAddon.extend({
    name: 'registries',

    cssModules: {
        headerModules: [
            'registries/styles/variables',
        ],
    },

    'ember-font-awesome': {
        includeFontAwesomeAssets: false,
    },
});
`;

const OSF_COMPONENTS_INDEX = `/* eslint-env node */

module.exports = {
    name: 'osf-components',

    options: {
        cssModules: {
            headerModules: [
                'osf-components/styles/headers',
            ],
        },
    },
};
`;

const OSF_COMPONENTS_HEADERS = `@import 'app/styles/variables';

// RegistriesStyle is controlled by a feature flag
// in the application template
:global(.RegistriesStyle) {
    h1 {
        font-size: 36px;
    }
}
`;

test("local-class moves to class", () => {
  expect(rewriteTemplate(SORT_BUTTON_TEMPLATE)).toEqual({
    output: SORT_BUTTON_TEMPLATE.replace("local-class=", "class="),
    leftovers: [],
  });
});

test("the local-class helper becomes scoped-class, unless it reads another file", () => {
  let source = `<nav
    data-test-nav
    local-class='Nav {{if this.dark 'Dark' 'Light'}} {{if this.mobile 'Mobile'}}'
    ...attributes
>
    {{yield (hash
        container=(component 'container' class=(local-class 'NavbarContainer'))
    )}}
</nav>
<p class="{{local-class 'postscript' from='app/components/welcome.css'}}"></p>
`;

  expect(rewriteTemplate(source)).toEqual({
    output: source
      .replace("local-class='Nav", "class='Nav")
      .replace("(local-class 'NavbarContainer')", "(scoped-class 'NavbarContainer')"),
    leftovers: ["line 10: {{local-class from=...}} reads the classes of another file"],
  });
});

test("local-class merges into class, with the quotes of class", () => {
  let source = `<div class='container' local-class='counts {{if this.isMobile 'mobile'}}'></div>
<div class='Application__page' local-class='Application__page'>
    {{outlet}}
</div>
`;

  expect(rewriteTemplate(source)).toEqual({
    output: `<div class="container counts {{if this.isMobile 'mobile'}}"></div>
<div class='Application__page'>
    {{outlet}}
</div>
`,
    leftovers: ['line 2: "Application__page" was a global class and a local class'],
  });
});

test("local-class arguments of curly invocations", () => {
  let source = `{{#paginated-list/has-many
    local-class='institutionList'
    model=@manager.user
}}
{{/paginated-list/has-many}}
{{placeholder.text class='line' local-class='SubscriptionPlaceholder' lines=1}}
`;

  expect(rewriteTemplate(source)).toEqual({
    output: `{{#paginated-list/has-many
    class=(scoped-class 'institutionList')
    model=@manager.user
}}
{{/paginated-list/has-many}}
{{placeholder.text class=(concat 'line' " " (scoped-class 'SubscriptionPlaceholder')) lines=1}}
`,
    leftovers: [],
  });
});

test(":global markers", () => {
  expect(unwrapGlobal(":global(.RegistriesStyle) {\n    h1 { color: red; }\n}\n")).toBe(
    ".RegistriesStyle {\n    h1 { color: red; }\n}\n",
  );
  expect(wrapBareGlobal("    :global .ember-content-placeholders-heading__title {")).toBe(
    "    :global(.ember-content-placeholders-heading__title) {",
  );
  expect(wrapBareGlobal(":global .a > .b,\n.c {")).toBe(":global(.a) > :global(.b),\n.c {");
});

test("top-level statements skip comments and interpolation", () => {
  let source = `// a { b }
@import 'variables';
.a-#{$name} { color: red; .b { color: blue; } }
`;

  expect(topLevel(source, true).map((statement) => statement.prelude)).toEqual([
    "@import 'variables'",
    ".a-#{$name}",
  ]);
});

test("composes declarations", () => {
  let source = `.contentBackground {
    composes: ContentBackground from '../../overview/styles.scss';
}

.Name {
    composes: Name;
}
`;

  expect(compositions(source).map(({ names, from }) => ({ names, from }))).toEqual([
    { names: ["ContentBackground"], from: "../../overview/styles.scss" },
    { names: ["Name"], from: undefined },
  ]);
});

test("a file with only variables adds no CSS", () => {
  let files = { "app/styles/_variables.scss": VARIABLES, "app/styles/headers.scss": HEADERS };
  let has = (/** @type {string} */ file) => file in files;
  let read = (/** @type {string} */ file) => files[/** @type {keyof typeof files} */ (file)];

  expect(definitionsOnly(has, read, "app/styles/_variables.scss", ["app/styles"])).toBe(true);
  expect(definitionsOnly(has, read, "app/styles/headers.scss", ["app/styles"])).toBe(false);
});

test("each module becomes a <style scoped> block in its template", () => {
  let app = project({
    "package.json": JSON.stringify({
      name: "ember-osf-web",
      devDependencies: { "ember-css-modules": "^1.0.3", "ember-css-modules-sass": "^1.0.1" },
    }),
    "ember-cli-build.js": BUILD,
    "app/styles/headers.scss": HEADERS,
    "app/styles/_variables.scss": VARIABLES,
    "lib/osf-components/package.json": JSON.stringify({ name: "osf-components" }),
    "lib/osf-components/index.js": OSF_COMPONENTS_INDEX,
    "lib/osf-components/addon/styles/headers.scss": OSF_COMPONENTS_HEADERS,
    "lib/osf-components/addon/components/sort-button/template.hbs": SORT_BUTTON_TEMPLATE,
    "lib/osf-components/addon/components/sort-button/styles.scss": SORT_BUTTON_STYLES,
    "lib/osf-components/addon/components/sort-button/component.ts": SORT_BUTTON_COMPONENT,
    "lib/registries/package.json": JSON.stringify({ name: "registries" }),
    "lib/registries/index.js": REGISTRIES_INDEX,
    "lib/registries/addon/styles/variables.scss": `@import 'app/styles/variables';\n\n$primary-blue: #337ab7;\n`,
    "lib/registries/addon/overview/template.hbs": `<div local-class='ContentBackground'></div>\n`,
    "lib/registries/addon/overview/styles.scss": `.ContentBackground {\n    display: flex;\n    color: $primary-blue;\n}\n`,
    "lib/registries/addon/branded/new/template.hbs": `<div local-class='contentBackground'></div>\n`,
    "lib/registries/addon/branded/new/styles.scss": `.contentBackground {\n    composes: ContentBackground from '../../overview/styles.scss';\n}\n`,
  });

  let result = plan(app);

  expect(result.writes.get("lib/osf-components/addon/components/sort-button/template.hbs"))
    .toBe(`<style scoped lang="scss">
@import '../../../../../app/styles/variables';

// stylelint-disable selector-class-pattern
.SortButton {
    padding-left: 10px;
    display: table-cell;

    :global(.btn) {
        &:active {
            box-shadow: none;
        }
    }

    .selected {
        color: $color-text-blue-dark !important;
    }
}
</style>

${SORT_BUTTON_TEMPLATE.replace("local-class=", "class=")}`);

  expect(result.writes.get("lib/registries/addon/branded/new/template.hbs"))
    .toBe(`<style scoped lang="scss">
@import '../../styles/variables';

.contentBackground {
    display: flex;
    color: $primary-blue;
}
</style>

<div class='contentBackground'></div>
`);

  expect(result.writes.get("app/styles/app.scss")).toBe("@import './headers';\n");
  expect(result.writes.get("lib/registries/addon/styles/variables.scss")).toBe(
    `@import '../../../../app/styles/variables';\n\n$primary-blue: #337ab7;\n`,
  );
  expect(result.writes.get("lib/osf-components/addon/styles/addon.scss")).toBe(
    "@import './headers';\n",
  );
  expect(result.writes.get("lib/osf-components/addon/styles/headers.scss")).toBe(
    OSF_COMPONENTS_HEADERS.replace(":global(.RegistriesStyle)", ".RegistriesStyle"),
  );
  expect(result.writes.get("lib/osf-components/addon/components/sort-button/component.ts")).toBe(
    SORT_BUTTON_COMPONENT.replace("import styles from './styles';\n", "").replace(
      "@layout(template, styles)",
      "@layout(template)",
    ),
  );
  expect(result.writes.get("ember-cli-build.js")).not.toContain("cssModules");
  expect(result.writes.get("lib/registries/index.js")).not.toContain("cssModules");
  expect(result.removes).toEqual([
    "lib/osf-components/addon/components/sort-button/styles.scss",
    "lib/registries/addon/branded/new/styles.scss",
    "lib/registries/addon/overview/styles.scss",
  ]);
  expect(Object.fromEntries(result.leftovers)).toEqual({
    "JavaScript that reads ember-css-modules": [
      'lib/osf-components/addon/components/sort-button/component.ts: import from "ember-css-modules"',
    ],
  });
});

test("variables that another module defined", () => {
  let source = `$sizes: 1 2 3; // $not-a-use
@mixin spin($from, $to) {
    transform: rotate($from);
}

.Header {
    background: url('assets/images/default-brand/bg-dark.jpg') top center $color-bg-color-grey;

    @for $i from 1 through 3 {
        .logo-#{nth($sizes, $i)} {
            @include spin(0deg, 360deg);
        }
    }
}
`;

  expect(undefinedVariables(source)).toEqual(["color-bg-color-grey"]);
});

test("styles imports stay when the code reads a class name", () => {
  /** @type {string[]} */
  let leftovers = [];
  let source = `import Component from '@ember/component';
import styles from './styles';

export default class Gutters extends Component {
    get slideClass() {
        return this.leftMode === 'page' ? styles.SlideRight : '';
    }
}
`;

  expect(removeStyleImports(source, "component.ts", (where) => leftovers.push(where))).toBe(source);
  expect(leftovers).toEqual(["component.ts: styles"]);
});

test("cssModules goes from the options of an in-repo addon", () => {
  let source = `module.exports = {
    name: 'osf-components',

    options: {
        cssModules: {
            headerModules: [
                'osf-components/styles/headers',
            ],
        },
    },
};
`;

  expect(removeOption(source, "index.js", "cssModules")).toBe(`module.exports = {
    name: 'osf-components',

    options: {
    },
};
`);
});

/**
 * From the app blueprint that ember-vite-codemod uses.
 */
const BABEL_CONFIG = `import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  babelCompatSupport,
  templateCompatSupport,
} from '@embroider/compat/babel';

export default {
  plugins: [
    [
      'babel-plugin-ember-template-compilation',
      {
        enableLegacyModules: [
          'ember-cli-htmlbars',
          'ember-cli-htmlbars-inline-precompile',
          'htmlbars-inline-precompile',
        ],
        transforms: [...templateCompatSupport()],
      },
    ],
    ...babelCompatSupport(),
  ],
};
`;

const VITE_CONFIG = `import { defineConfig } from 'vite';
import { extensions, classicEmberSupport, ember } from '@embroider/vite';
import { babel } from '@rollup/plugin-babel';

export default defineConfig({
  plugins: [
    classicEmberSupport(),
    ember(),
    // extra plugins here
    babel({
      babelHelpers: 'runtime',
      extensions,
    }),
  ],
});
`;

test("the template transform of ember-scoped-css goes in the Babel config", () => {
  expect(
    addTemplateTransform(
      BABEL_CONFIG,
      "babel.config.mjs",
      "{ additionalRoots: ['lib/registries/addon'] }",
    ),
  ).toBe(
    BABEL_CONFIG.replace(
      "} from '@embroider/compat/babel';",
      "} from '@embroider/compat/babel';\nimport { scopedCSS } from 'ember-scoped-css/babel';",
    ).replace(
      "transforms: [...templateCompatSupport()]",
      "transforms: [...templateCompatSupport(), scopedCSS.template({ additionalRoots: ['lib/registries/addon'] })]",
    ),
  );
});

test("the Vite plugin of ember-scoped-css goes first", () => {
  let app = project({ "vite.config.mjs": VITE_CONFIG });

  addVitePlugin(app, {
    importLine: "import { scopedCSS } from 'ember-scoped-css/vite';",
    call: "scopedCSS()",
    specifier: "ember-scoped-css/vite",
    first: true,
  });

  expect(app.read("vite.config.mjs")).toBe(
    VITE_CONFIG.replace(
      "import { babel } from '@rollup/plugin-babel';",
      "import { babel } from '@rollup/plugin-babel';\nimport { scopedCSS } from 'ember-scoped-css/vite';",
    ).replace("    classicEmberSupport(),", "    scopedCSS(),\n    classicEmberSupport(),"),
  );
});

test("in-repo addons and pods need additionalRoots", () => {
  let app = project({
    "app/components/a.hbs": "<style scoped>\n.a {}\n</style>\n",
    "app/application/template.hbs": "<style scoped>\n.a {}\n</style>\n",
    "lib/registries/addon/overview/template.hbs": "<style scoped>\n.a {}\n</style>\n",
    "lib/other/addon/components/b/template.hbs": "<div></div>\n",
  });

  expect(additionalRoots(app)).toEqual(["app", "lib/registries/addon"]);
});

test("an app on ember-scoped-css-compat keeps its setup", () => {
  let files = {
    "vite.config.mjs": "export default {};\n",
  };
  let current = project({
    ...files,
    "package.json": JSON.stringify({ devDependencies: { "ember-scoped-css": "^3.0.0" } }),
  });
  let compat = project({
    ...files,
    "package.json": JSON.stringify({
      devDependencies: { "ember-scoped-css": "^0.24.3", "ember-scoped-css-compat": "^10.2.3" },
    }),
  });

  expect(emberScopedCss.detect(current)).toBe(true);
  expect(emberScopedCss.detect(compat)).toBe(false);
});
