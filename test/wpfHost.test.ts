import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHostFailure } from "../src/host/WpfHost.ts";

// Dosłowna diagnostyka apphosta .NET, gdy brakuje frameworka desktopowego.
const APPHOST_MISSING_RUNTIME = `You must install or update .NET to run this application.

App: C:\\ext\\wpf-host\\bin\\Release\\net10.0-windows\\xve-wpf-host.exe
Architecture: x64
Framework: 'Microsoft.WindowsDesktop.App', version '10.0.0' (x64)
.NET location: C:\\Program Files\\dotnet\\

The following frameworks were found:
  8.0.11 at [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed
`;

// Wariant, gdy nie ma w ogóle żadnego frameworka (inna gałąź komunikatu hostfxr).
const HOSTFXR_NOT_FOUND = `A fatal error occurred. The required library hostfxr.dll could not be found.
The framework 'Microsoft.WindowsDesktop.App', version '10.0.0' (x64) was not found.`;

test("classifyHostFailure: brak .NET Desktop Runtime", () => {
  assert.equal(classifyHostFailure(APPHOST_MISSING_RUNTIME), "runtime-missing");
  assert.equal(classifyHostFailure(HOSTFXR_NOT_FOUND), "runtime-missing");
});

test("classifyHostFailure: zwykły crash to nie brak runtime'u", () => {
  assert.equal(
    classifyHostFailure("Unhandled exception. System.NullReferenceException: Object reference not set."),
    "crash"
  );
  assert.equal(classifyHostFailure("Access is denied."), "crash");
});

test("classifyHostFailure: pusty stderr → crash (nie zgadujemy runtime'u)", () => {
  assert.equal(classifyHostFailure(""), "crash");
  assert.equal(classifyHostFailure("   \n"), "crash");
});

test("classifyHostFailure: rozpoznanie jest niewrażliwe na wielkość liter", () => {
  assert.equal(classifyHostFailure("you must install or update .NET"), "runtime-missing");
  assert.equal(classifyHostFailure("FRAMEWORK: 'microsoft.windowsdesktop.app'"), "runtime-missing");
});
