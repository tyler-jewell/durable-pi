// Scaffolds web apps from templates, and adds routes and pages to them. Generated code only: the template holds the
// standard (responsive, offline-first PWA, Modern Web Guidance), and these commands fill it in.
//
//   just app add app <name> ["Title"]              a new app in apps/<name>, from templates/pwa-vue
//   just app add route <app> </path> <Name>        a page (src/pages/<Name>.vue) and its route
//   just app add page <app> <Name>                 a page component with no route
//
// The route table has marked regions (src/routes.ts). Only those regions are edited; nothing else in an app is rewritten.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "pwa-vue");
const APPS = join(ROOT, "apps");
const TEXT_EXT = new Set([".ts", ".vue", ".html", ".json", ".css", ".md", ".svg", ".mts"]);

const die = (msg: string): never => {
  console.error(`app: ${msg}`);
  process.exit(2);
};

const titleCase = (name: string) =>
  name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function appDir(name: string): string {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) die(`app name "${name}" must be lowercase letters, digits and hyphens`);
  const dir = join(APPS, name);
  if (!existsSync(dir)) die(`no app "${name}" in apps/ (create it with: just app add app ${name})`);
  return dir;
}

function addApp(name: string, title: string): void {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) die(`app name "${name}" must be lowercase letters, digits and hyphens`);
  const dest = join(APPS, name);
  if (existsSync(dest)) die(`apps/${name} already exists`);
  if (title.includes('"')) die("title must not contain double quotes");
  for (const src of walk(TEMPLATE)) {
    const rel = relative(TEMPLATE, src);
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    if (TEXT_EXT.has(extname(src))) {
      writeFileSync(
        out,
        readFileSync(src, "utf8").replaceAll("__APP_NAME__", name).replaceAll("__APP_TITLE__", title),
      );
    } else {
      writeFileSync(out, readFileSync(src));
    }
  }
  console.log(`created apps/${name} from templates/pwa-vue ("${title}")`);
  console.log(`next: just app verify ${name}`);
}

function pageComponent(name: string, title: string): string {
  return `<script setup lang="ts">
const props = defineProps<{ title: string }>();
</script>

<template>
  <section class="page">
    <h1>{{ props.title }}</h1>
    <p>${title}: edit this page freely.</p>
  </section>
</template>
`;
}

function addPage(app: string, name: string): string {
  if (!/^[A-Z][A-Za-z0-9]{0,40}$/.test(name)) die(`page name "${name}" must be PascalCase, e.g. Settings`);
  const file = join(appDir(app), "src", "pages", `${name}.vue`);
  if (existsSync(file)) die(`${relative(ROOT, file)} already exists`);
  writeFileSync(file, pageComponent(name, titleCase(name)));
  return file;
}

function addRoute(app: string, path: string, name: string): void {
  if (!/^\/[a-z0-9-]*(\/[a-z0-9-]+)*$/.test(path)) die(`route "${path}" must be lowercase path segments, e.g. /settings`);
  const dir = appDir(app);
  const routesFile = join(dir, "src", "routes.ts");
  const src = readFileSync(routesFile, "utf8");
  const routeName = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (new RegExp(`path: "${path.replace(/\//g, "\\/")}"`).test(src)) die(`route ${path} already exists in ${app}`);
  if (new RegExp(`name: "${routeName}"`).test(src)) die(`route name "${routeName}" already exists in ${app}`);

  const file = addPage(app, name);
  const importLine = `import ${name} from "./pages/${name}.vue";`;
  const entry = `  { path: "${path}", name: "${routeName}", component: ${name}, props: { title: "${titleCase(name)}" } },`;
  const next = src
    .replace("// @generated:imports-end", `${importLine}\n// @generated:imports-end`)
    .replace("  // @generated:routes-end", `${entry}\n  // @generated:routes-end`);
  if (next === src) die(`src/routes.ts has no generated markers in ${app}`);
  writeFileSync(routesFile, next);
  console.log(`added ${path} → ${relative(ROOT, file)} in apps/${app}`);
}

const [cmd, kind, ...rest] = process.argv.slice(2);
if (cmd !== "add") die("usage: app.mts add app|route|page ...");
if (kind === "app") {
  if (!rest[0]) die('usage: add app <name> ["Title"]');
  addApp(rest[0], rest[1] ?? titleCase(rest[0]));
} else if (kind === "route") {
  const [app, path, name] = rest;
  if (!app || !path || !name) die("usage: add route <app> </path> <Name>");
  addRoute(app, path, name);
} else if (kind === "page") {
  const [app, name] = rest;
  if (!app || !name) die("usage: add page <app> <Name>");
  console.log(`added ${relative(ROOT, addPage(app, name))}`);
} else {
  die("usage: app.mts add app|route|page ...");
}
