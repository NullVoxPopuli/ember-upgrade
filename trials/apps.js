/**
 * Real apps that CI upgrades on each change.
 *
 * Each app is pinned to a commit, so a change in the app cannot break CI.
 * `completed` lists the stages that must commit, in order.
 * `stopsAt` is the stage where the run must stop, and a part of its message.
 *
 * When a change gets an app further, the trial fails until this file says so.
 * That keeps progress visible, and stops a regression from hiding behind an old failure.
 *
 * @typedef {object} TrialApp
 * @property {string} name
 * @property {string} repo the GitHub owner/name
 * @property {string} sha
 * @property {string} [directory] the app inside a monorepo
 * @property {boolean} [verify] install and build after each stage
 * @property {string[][]} [setup] commands to run before the upgrade, for example to fetch data that the build reads
 * @property {string[]} completed
 * @property {{ stage: string, message: string }} [stopsAt]
 * @property {string[][]} [after] commands to run when every stage completes
 */

/**
 * The Ember 2.x and 3.x apps do not install on Node 24 (node-sass, old ember-cli),
 * so their trials check the code changes without a build.
 *
 * travis-ci/travis-web is not here: it installs a private git dependency (travis-aida).
 *
 * @type {TrialApp[]}
 */
export const apps = [
  {
    name: "hospitalrun",
    repo: "HospitalRun/hospitalrun-frontend",
    sha: "872cd97f3bbd73ea4403396995b7769c4fa13957",
    completed: ["ember-globals"],
    stopsAt: { stage: "vite", message: "older than 3.28" },
  },
  {
    name: "code-corps",
    repo: "code-corps/code-corps-ember",
    sha: "bc074964adcb23e8af61c38bcb6353ecc1022a0c",
    completed: ["ember-globals"],
    stopsAt: { stage: "vite", message: "older than 3.28" },
  },
  {
    name: "ember-observer",
    repo: "emberobserver/client",
    sha: "94e197af754b703dee9d30df030f63f95691c4b1",
    completed: [],
    stopsAt: { stage: "vite", message: "older than 3.28" },
  },
  {
    name: "super-rentals",
    verify: true,
    repo: "ember-learn/super-rentals",
    sha: "6d2414ed6d3f788c4fc072c6e3b5a42640ccb26e",
    completed: ["vite", "ember-cli-deprecation-workflow", "template-tag"],
    stopsAt: { stage: "ember-nvp", message: "An ember-source older than 7.2" },
  },
  {
    name: "ember-api-docs",
    verify: true,
    repo: "ember-learn/ember-api-docs",
    sha: "3f3aba0cc5b9274bf771cfa6c033ddd29f4330c8",
    setup: [["npm", "run", "clone"]],
    completed: [
      "ember-web-app",
      "ember-styleguide",
      "vite",
      "ember-cli-deploy",
      "ember-cli-autoprefixer",
      "ember-test-selectors",
      "prember",
      "ember-cli-deprecation-workflow",
      "ember-metrics",
      "update-ember-cli-showdown",
      "update-ember-decorators",
      "v1-addons",
      "svg-jar",
    ],
    stopsAt: { stage: "ember-nvp", message: "An ember-source older than 7.2" },
  },
  {
    name: "crates.io",
    verify: true,
    repo: "rust-lang/crates.io",
    /**
     * The last commit with the Ember frontend. The next commit moves crates.io to Svelte.
     */
    sha: "e7004ce2883da90028147418839881408c46ea39",
    completed: [],
  },
  {
    name: "croodle",
    verify: true,
    repo: "jelhan/croodle",
    sha: "7fca47194a90246533935b46720f502146644bd0",
    directory: "client",
    completed: [],
  },
];
