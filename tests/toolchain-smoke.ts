const marker: "snoredex-toolchain-ok" = "snoredex-toolchain-ok";

if (marker !== "snoredex-toolchain-ok") {
  throw new Error("TypeScript execution failed");
}

export {};
