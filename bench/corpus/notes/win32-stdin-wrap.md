# Win32 stdin re-wrap

## Closing a redirected buffer

When stdin comes from a pipe on Windows, the CRT layer wraps the raw
handle. Closing the wrapper too early leaves the underlying console
handle in a broken state.

## Re-wrap pattern

- Detect `process.stdin.isTTY === false`.
- Read the whole stream once into a buffer.
- Close the wrapper, then immediately re-open the raw handle via
  `GetStdHandle(STD_INPUT_HANDLE)`.
- Only issue console mode calls on the re-wrapped handle.

## Pitfall

Calling `SetConsoleMode` on a closed wrapper raises `ERROR_INVALID_HANDLE`.
Guard every console API call with the current handle validity.
