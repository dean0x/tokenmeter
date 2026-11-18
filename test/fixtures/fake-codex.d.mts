export type FakeMode = "env" | "eof" | "hang" | "wide" | "many" | "split" | "old" | "bad" | "large" | "fail";
export function writeFakeCodex(folder: string, mode?: FakeMode): string;
