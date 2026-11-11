import type { RobotCommand } from "../../src/types";
import type { RobotTransport } from "./transport";
export class MockRobotTransport implements RobotTransport {
  readonly commands:RobotCommand[]=[]; private handler?: (event:{type:string;payload:Record<string,unknown>})=>void;
  async connect(){} async sendCommand(command:RobotCommand){this.commands.push(command)}
  onEvent(handler:(event:{type:string;payload:Record<string,unknown>})=>void){this.handler=handler}
  emit(event:{type:string;payload:Record<string,unknown>}){this.handler?.(event)} async disconnect(){}
}
