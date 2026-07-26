// The real `server-only` package (node_modules/server-only/index.js) throws
// unconditionally unless resolved under Next's webpack/turbopack "react-server"
// export condition — which the plain Playwright/Node unit-test runner never
// sets. Every src/core/service/* module starts with `import "server-only"`,
// so importing them here would otherwise always throw
// "This module cannot be imported from a Client Component module."
//
// Patch Module._load to short-circuit that one package before any test file
// imports a service module. Must be the FIRST import in any test file that
// (transitively) touches a "server-only"-tagged module — ES import order is
// preserved as sequential requires, so this side effect runs before later
// imports resolve.
import Module from "node:module";

const moduleWithLoad = Module as unknown as {
  _load: (request: string, ...rest: unknown[]) => unknown;
};
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(request: string, ...rest: unknown[]) {
  if (request === "server-only") return {};
  return originalLoad.apply(this, [request, ...rest]);
};
