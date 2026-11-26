import { expect, test } from "vitest";

import { convertImports, convertLoads, convertMaps } from "#stages/addons/leaflet.js";

/**
 * From ember-learn/ember-website app/templates/community/meetups/index.gts, shortened.
 */
const MEETUPS = `import { LinkTo } from '@ember/routing';
// @ts-expect-error: Incorrect type
import LeafletMap from 'ember-leaflet/components/leaflet-map';

<template>
  {{#if @controller.leafletPackageLoaded}}
    <LeafletMap
      @class="leaflet-container"
      @lat={{@controller.leafletConfiguration.latitude}}
      @lng={{@controller.leafletConfiguration.longitude}}
      @zoom={{@controller.leafletConfiguration.zoom}}
      as |layers|
    >
      <layers.tile
        @url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
      />

      {{#each @model as |meetup|}}
        <layers.marker @lat={{meetup.lat}} @lng={{meetup.lng}} as |marker|>
          <marker.popup>
            <a href={{meetup.url}}>{{meetup.location}}</a>
          </marker.popup>
        </layers.marker>
      {{/each}}
    </LeafletMap>
  {{/if}}
</template>
`;

test("a Leaflet map becomes a MapLibre map, with its tiles as a raster source and pins for its markers", () => {
  let imports = convertImports(MEETUPS, "app/templates/community/meetups/index.gts");

  expect(imports?.tag).toBe("LeafletMap");

  let result = convertMaps(
    /** @type {{ output: string }} */ (imports).output,
    "app/templates/community/meetups/index.gts",
    "LeafletMap",
    "MapLibreGL",
  );

  expect(result.unreadable).toEqual([]);
  expect(result.output).toMatchInlineSnapshot(`
    "import { LinkTo } from '@ember/routing';
    import MapLibreGL from 'ember-maplibre-gl/components/maplibre-gl';
    import { array, hash } from '@ember/helper';

    <template>
      {{#if @controller.leafletPackageLoaded}}
        <MapLibreGL class="leaflet-container" @initOptions={{hash style=(hash version=8 sources=(hash) layers=(array)) center=(array @controller.leafletConfiguration.longitude @controller.leafletConfiguration.latitude) zoom=@controller.leafletConfiguration.zoom}} as |layers|><layers.source @options={{hash type="raster" tiles=(array "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png" "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png" "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png") tileSize=256}} as |tileSource|><tileSource.layer @options={{hash type="raster"}} /></layers.source>

          {{#each @model as |meetup|}}
            <layers.marker @lngLat={{array meetup.lng meetup.lat}} @initOptions={{hash anchor="bottom"}} as |marker|><svg width="27" height="41" viewBox="0 0 27 41" aria-hidden="true"><path fill="#3FB1CE" d="M13.5 0C6 0 0 6 0 13.5 0 23.6 13.5 41 13.5 41S27 23.6 27 13.5C27 6 21 0 13.5 0z" /><circle fill="#fff" cx="13.5" cy="13.5" r="5.5" /></svg><marker.popup>
                <a href={{meetup.url}}>{{meetup.location}}</a>
              </marker.popup>
            </layers.marker>
          {{/each}}
        </MapLibreGL>
      {{/if}}
    </template>
    "
  `);
});

test("a layer that MapLibre has no match for stops the conversion", () => {
  let result = convertMaps(
    `<LeafletMap @lat={{1}} @lng={{2}} as |layers|><layers.polyline @locations={{this.path}} /></LeafletMap>\n`,
    "app/components/route-map.hbs",
    "LeafletMap",
    "MaplibreGl",
  );

  expect(result.unreadable).toEqual(["layers.polyline"]);
  expect(result.output).toBe(
    `<LeafletMap @lat={{1}} @lng={{2}} as |layers|><layers.polyline @locations={{this.path}} /></LeafletMap>\n`,
  );
});

/**
 * From ember-learn/ember-website app/controllers/community/meetups/index.ts, shortened.
 */
test("a load of leaflet that only waits for it loads maplibre-gl", () => {
  expect(
    convertLoads(
      `export default class extends Controller {
  constructor() {
    super(...arguments);
    void import('leaflet').then(() => {
      this.leafletPackageLoaded = true;
    });
  }
}
`,
      "app/controllers/community/meetups/index.ts",
    ),
  ).toMatchInlineSnapshot(`
    {
      "output": "export default class extends Controller {
      constructor() {
        super(...arguments);
        void import('maplibre-gl').then(() => {
          this.leafletPackageLoaded = true;
        });
      }
    }
    ",
      "unreadable": [],
    }
  `);
});

/**
 * From ember-learn/ember-website app/controllers/community/meetups/index.ts (MIT), shortened.
 */
test("the settings of the Leaflet marker icons go, with the constants that only they read", () => {
  expect(
    convertLoads(
      `export default class extends Controller {
  constructor() {
    super(...arguments);

    if (!import.meta.env.SSR) {
      // @ts-expect-error: Incorrect type
      void import('leaflet').then(() => {
        if (this.isDestroyed || this.isDestroying) {
          return;
        }

        // @ts-expect-error: Incorrect type
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        const config = getOwner(this).resolveRegistration('config:environment');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        const prefix = config.rootURL;

        // @ts-expect-error: Incorrect type
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        L.Icon.Default.imagePath = \`\${prefix}assets/images/\`;

        this.leafletPackageLoaded = true;
      });
    }
  }
}
`,
      "app/controllers/community/meetups/index.ts",
    ),
  ).toMatchInlineSnapshot(`
    {
      "output": "export default class extends Controller {
      constructor() {
        super(...arguments);

        if (!import.meta.env.SSR) {
          // @ts-expect-error: Incorrect type
          void import('maplibre-gl').then(() => {
            if (this.isDestroyed || this.isDestroying) {
              return;
            }



            this.leafletPackageLoaded = true;
          });
        }
      }
    }
    ",
      "unreadable": [],
    }
  `);
});

test("another read of the Leaflet global after the load is for the user", () => {
  expect(
    convertLoads(
      `import('leaflet').then(() => {
  L.Icon.Default.imagePath = '/images/';
  L.control.scale().addTo(map);
});
`,
      "app/map.js",
    ).unreadable,
  ).toMatchInlineSnapshot(`
    [
      "the Leaflet global \`L\`, after import('leaflet')",
    ]
  `);
});
