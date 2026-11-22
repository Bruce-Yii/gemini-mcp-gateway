#!/usr/bin/env node
/**
 * Generate a coverage-oriented Figma task set from the committed tools/list
 * snapshot + official Tools docs list. One task per retained tool; prompts are
 * executable hints, not a benchmark score. Re-run after snapshot/tool changes.
 *
 * Usage: node scripts/gen-figma-tasks.mjs
 * Output: explore/figma-tasks.json
 */
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(fs.readFileSync(resolve(root, 'data/tool-snapshots/figma.json'), 'utf8'));
const official = JSON.parse(fs.readFileSync(resolve(root, 'data/official-tools/figma.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(resolve(root, 'config.example.json'), 'utf8'));
const server = config.servers.find((item) => item.name === 'figma');
const deny = new Set(server?.denyTools ?? []);
const fileKey = 'izWTtDxzzsdcA5ZWyaquvS';
const planKey = 'team::1666468412261620272';
const docsUrl = 'https://help.figma.com/hc/en-us/articles/42495147242903-Tools-and-example-prompts';

const officialNames = new Set(official.tools.map((tool) => tool.name));

// Prompts here are coverage prompts, not official benchmark prompts. Only a
// subset is marked official-verbatim; the rest are schema-reverse.
const PROMPTS = {
  get_screenshot: ['Take a screenshot of a frame in the test Figma file (first call get_metadata to find a page/frame node id).', 'schema-reverse'],
  get_design_context: ['Generate my Figma selection in Vue.', 'official-verbatim'],
  get_motion_context: ['Use get_motion_context to get keyframe animation data for an animated node in the test Figma file.', 'schema-reverse'],
  get_metadata: ['Use get_metadata to get a lightweight XML outline of the test Figma file pages, then list the page names.', 'schema-reverse'],
  get_comments: ['Summarize the unread comments in this Figma file: https://www.figma.com/design/izWTtDxzzsdcA5ZWyaquvS.', 'official-verbatim'],
  get_variable_defs: ['Get the variables used in my Figma selection.', 'official-verbatim'],
  get_figjam: ['Use get_figjam to read the FigJam diagram in the test file and convert it to an XML outline.', 'schema-reverse'],
  generate_image: ['Generate a hero image of a mountain trail at sunrise for our landing page.', 'official-verbatim'],
  generate_vector_illustration: ['Generate a flat vector illustration of a fox jumping over a fence and add it to https://www.figma.com/design/izWTtDxzzsdcA5ZWyaquvS.', 'official-verbatim'],
  generate_figma_design: ['Use generate_figma_design to capture a live web page into the existing test Figma design file.', 'schema-reverse'],
  generate_diagram: ['Create a flowchart for the user authentication flow using the Figma MCP generate_diagram tool.', 'official-verbatim'],
  get_code_connect_map: ['Use get_code_connect_map to get Code Connect mappings for a component instance in the test Figma file.', 'schema-reverse'],
  whoami: ['Get my Figma identity, plans and seats using whoami.', 'schema-reverse'],
  add_code_connect_map: ['Use add_code_connect_map to map a Figma component in the test file to a code component named Button.', 'schema-reverse'],
  get_code_connect_suggestions: ['Use get_code_connect_suggestions to suggest Code Connect mappings for a component instance in the test Figma file.', 'schema-reverse'],
  send_code_connect_mappings: ['Use send_code_connect_mappings to confirm and save the suggested Code Connect mappings for a component in the test file.', 'schema-reverse'],
  export_video: ['Export this animated frame as an MP4.', 'official-verbatim'],
  get_context_for_code_connect: ['Use get_context_for_code_connect to get component metadata needed for a Code Connect template from the test file.', 'schema-reverse'],
  use_figma: ['Add a new frame to my Figma file.', 'official-verbatim'],
  create_session: ['Use create_session to create a Figma session for the test file before starting file-tool work.', 'schema-reverse'],
  create_branch: ['Use create_branch to create a new branch of the test Figma design file.', 'schema-reverse'],
  get_libraries: ['Use get_libraries to list the design libraries associated with the test Figma file.', 'schema-reverse'],
  search_design_system: ['Search for a button component in my design system.', 'official-verbatim'],
  create_new_file: ['Create a new Figma file called "Homepage Redesign."', 'official-verbatim'],
  send_code_to_figma: ['Use send_code_to_figma to import a small local project into a Figma Make or Design code layer.', 'schema-reverse'],
  upload_assets: ['Use upload_assets to upload a small SVG icon into the test Figma file.', 'schema-reverse'],
  html_to_figma: ['Create a style sheet from our design tokens and add it to https://www.figma.com/design/izWTtDxzzsdcA5ZWyaquvS.', 'official-verbatim'],
  download_assets: ['Export these icons from my Figma file as SVGs.', 'official-verbatim'],
  list_file_shaders: ['Use list_file_shaders to list the shader effects and fills used in the test Figma file.', 'schema-reverse'],
  list_shaders: ['List the shaders in my library.', 'official-verbatim'],
  get_shader: ['Show me the source for my star field shader.', 'official-verbatim'],
  list_generative_plugins: ['List my generative plugins.', 'official-verbatim'],
  get_generative_plugin: ['Show me the source for my layer-renaming plugin.', 'official-verbatim'],
  create_generative_plugin: ['Create a new generative plugin called "Layer renamer" in my team plan.', 'official-verbatim'],
  create_shader: ['Create a shader fill called "Topographic contours" in my team plan.', 'official-verbatim'],
  update_generative_plugin: ['Use update_generative_plugin to update the Layer renamer generative plugin with a commit message.', 'schema-reverse'],
  update_shader: ['Use update_shader to update the Topographic contours shader fill with a commit message.', 'schema-reverse'],
};

const tasks = [];
let index = 0;
for (const tool of snapshot.tools) {
  if (deny.has(tool.name)) continue;
  index += 1;
  const [prompt, authority] = PROMPTS[tool.name] ?? [
    `Use the Figma MCP tool "${tool.name}" on the test Figma file (${fileKey}) to ${(tool.description ?? '').split('.')[0].toLowerCase().slice(0, 140)}.`,
    'schema-reverse',
  ];
  const task = {
    id: `FIG-${String(index).padStart(3, '0')}`,
    server: 'figma',
    tool: tool.name,
    prompt,
    authority,
    source: docsUrl,
    category: authority === 'official-verbatim' ? 'official' : 'derived',
    official: authority === 'official-verbatim',
    expectedTools: [tool.name],
    preconditions: [
      `test fileKey ${fileKey}`,
      `planKey ${planKey}`,
    ],
  };
  if (tool.name.startsWith('weave_')) {
    task.skipReason = 'requires a paid Figma Weave account';
  }
  tasks.push(task);
}

const byAuthority = tasks.reduce((acc, task) => {
  acc[task.authority] = (acc[task.authority] ?? 0) + 1;
  return acc;
}, {});
const output = {
  generatedAt: new Date().toISOString(),
  description: 'Coverage tasks for every retained Figma tool (one task per tool).',
  count: tasks.length,
  officialCount: tasks.filter((task) => task.official).length,
  skipped: tasks.filter((task) => task.skipReason).length,
  authorityCounts: byAuthority,
  tasks,
};
const target = resolve(root, 'explore/figma-tasks.json');
fs.writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
console.log(`[gen-figma-tasks] ${tasks.length} tasks -> ${target}`);
console.log(`[gen-figma-tasks] official=${output.officialCount} schema=${tasks.length - output.officialCount} skipped=${output.skipped}`);
