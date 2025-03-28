the function pointers like "enc_write_fn_ptr" must be added after createWasm finishes,
which is when the ready event is fired, otherwise code complains that there is no table

the dev version contains a check that fails when the library is loaded by production bundler
on Next.js.
it doesn't surface when running dev mode with turbopack.
The root cause is that emscripten does not natively support AudioWorkletGlobalScope.
Therefore, we have to compile for the SHELL environment, and the check doesn't work for
an audio worklet.

newer versions of emscripten seem unhappy to accept ES module syntax in pre and post js
files.
Therefore, have to revert to UMD.
The side effect is that the UMD code that assigns "root" also does not work in
AudioWorkletGlobalScope.
Replacing that with hardcoded `globalThis` works.