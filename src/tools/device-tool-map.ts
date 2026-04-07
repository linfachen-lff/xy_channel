// Device type to tool name mapping.
// Only tools listed under a device type are available for that device.
// Tools NOT listed here are available to ALL devices (no restriction).

/** Known device type enum. */
export const DEVICE_TYPES = ["car", "pc", "phone"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * Map: deviceType → tool names allowed for that device.
 * undefined / empty deviceType → all tools available.
 * Unrecognized deviceType → all tools available.
 * Tool not listed in any device entry → available to all devices.
 */
const DEVICE_TOOL_ALLOWLIST: Partial<Record<DeviceType, string[]>> = {
  car: ["send_command_to_car"],
  pc: ["location"],
};

export function filterToolsByDevice(tools: any[], deviceType?: string): any[] {
  if (!deviceType) return tools;

  const allowedTools = (DEVICE_TOOL_ALLOWLIST as Record<string, string[]>)[deviceType];
  if (!allowedTools) return tools; // unrecognized device → no filtering

  return tools.filter((tool) => allowedTools.includes(tool.name));
}
