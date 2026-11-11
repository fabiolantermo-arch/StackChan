import type { RobotCommand } from "../../src/types";
/** Adapter boundary only: do not assume pins, SDK, firmware or protocol until K151 is verified. */
export interface RobotTransport { connect():Promise<void>; sendCommand(command:RobotCommand):Promise<void>; onEvent(handler:(event:{type:string;payload:Record<string,unknown>})=>void):void; disconnect():Promise<void>; }
