// Next.js only ever calls the register() exported from THIS exact file — it
// does not also load instrumentation.node.ts on its own. All Node.js-specific
// startup logic (user-apps/ seeding, service registry + scheduler daemon
// start) lives there instead, kept out of the Edge runtime bundle by gating
// the import behind NEXT_RUNTIME.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNode } = await import("./instrumentation.node");
    await registerNode();
  }
}
