// @golf/mcp — the Model Context Protocol tool surface over the practice
// history (BUILD_SPEC Phase 5). Pure and transport-free: every tool takes an
// injected DataStore and returns plain JSON. The stdio server that publishes
// them lives at the hub edge (apps/hub/src/mcp), the same seam pattern the
// BLE and monitor transports use.
export * from './tool';
export * from './history';
export * from './catalog';
export * from './clubs';
export * from './sessions';
export * from './shots';
export * from './insights';
export * from './program';
export * from './recaps';
