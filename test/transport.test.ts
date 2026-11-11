import { describe, expect, it } from "vitest";
import { MockRobotTransport } from "../firmware/transport-stub/mock";
describe("robot transport stub",()=>{ it("records commands without touching hardware",async()=>{ const transport=new MockRobotTransport(); await transport.connect(); await transport.sendCommand({type:"face",payload:{state:"idle"}}); expect(transport.commands).toHaveLength(1); expect(transport.commands[0].payload.state).toBe("idle"); }); });
