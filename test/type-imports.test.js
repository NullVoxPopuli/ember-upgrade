import { expect, test } from "vitest";

import { markTypeImports } from "#stages/type-imports/index.js";

/**
 * From hashicorp-forge/hermes web/app/components/related-resource/external-link.gts, shortened.
 */
test("an import that the module uses only as types says `type`", () => {
  let source = `import Component from "@glimmer/component";
import { RelatedExternalLink, RelatedResource } from "../related-resources";
import { assert } from "@ember/debug";

interface RelatedResourceExternalLinkComponentSignature {
  Args: {
    resource: RelatedResource;
  };
  Blocks: {
    default: [RelatedExternalLink];
  };
}

export default class RelatedResourceExternalLinkComponent extends Component<RelatedResourceExternalLinkComponentSignature> {
  protected get link(): RelatedExternalLink {
    assert("url must exist on the resource", "url" in this.args.resource);
    return this.args.resource as RelatedExternalLink;
  }

  <template>
    {{yield this.link}}
  </template>
}
`;

  expect(markTypeImports(source, "app/components/related-resource/external-link.gts"))
    .toMatchInlineSnapshot(`
      "import Component from "@glimmer/component";
      import type { RelatedExternalLink, RelatedResource } from "../related-resources";
      import { assert } from "@ember/debug";

      interface RelatedResourceExternalLinkComponentSignature {
        Args: {
          resource: RelatedResource;
        };
        Blocks: {
          default: [RelatedExternalLink];
        };
      }

      export default class RelatedResourceExternalLinkComponent extends Component<RelatedResourceExternalLinkComponentSignature> {
        protected get link(): RelatedExternalLink {
          assert("url must exist on the resource", "url" in this.args.resource);
          return this.args.resource as RelatedExternalLink;
        }

        <template>
          {{yield this.link}}
        </template>
      }
      "
    `);
});

/**
 * A mix of the hermes imports, with a value, a template name, and a type in one import.
 */
test("only the specifiers that are types say `type`, and template names are values", () => {
  let source = `import { RelatedResourcesScope, RelatedResource } from "../related-resources";
import Tile, { TileArgs } from "./tile";
import type { Already } from "./already";

export default class List extends Component<{ Args: { scope: RelatedResourcesScope, tile: TileArgs, x: Already } }> {
  scope = RelatedResourcesScope.Document;
  resource?: RelatedResource;

  <template><Tile @args={{@tile}} /></template>
}
`;

  expect(markTypeImports(source, "app/components/list.gts")).toMatchInlineSnapshot(`
    "import { RelatedResourcesScope, type RelatedResource } from "../related-resources";
    import Tile, { type TileArgs } from "./tile";
    import type { Already } from "./already";

    export default class List extends Component<{ Args: { scope: RelatedResourcesScope, tile: TileArgs, x: Already } }> {
      scope = RelatedResourcesScope.Document;
      resource?: RelatedResource;

      <template><Tile @args={{@tile}} /></template>
    }
    "
  `);
});
