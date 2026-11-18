export type FakeMode = "env" | "eof" | "hang" | "wide" | "many" | "split" | "old" | "bad" | "large" | "fail" | "rpc" | "rpc-old" | "rpc-switch-off";
export function writeFakeCodex(folder: string, mode?: FakeMode): string;
