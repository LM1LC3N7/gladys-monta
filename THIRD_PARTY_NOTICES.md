# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## monta-python

Its Monta client (`src/client.js`, `src/monta.js`, the routes, states and
token handling of `src/constants.js` and `src/model.js`) is a JavaScript port
of parts of **monta-python** (<https://github.com/nickknissen/monta-python>,
version 1.2.0, commit 46dc6bc of 2026-08-20), the Python client of the Monta
public API maintained by Nick Nissen: the token got from the client id and
secret (`auth/token`), its renewal from the refresh token (`auth/refresh`)
with the fallback to the client credentials when the refresh token is
refused, a refused access token replaced and the request sent once more, the
401/403/429 handling with `Retry-After`, the `charge-points` list (pages,
items without a serial number skipped), one charge point, the `charges` list
and its filters, starting (`POST charges`) and stopping
(`POST charges/{id}/stop`) a charge, and the charge point and charge states.
No Python code runs here and monta-python is not a dependency. Its license:

```
MIT License

Copyright (c) 2025 Nick Nissen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Monta public API itself is documented by Monta at
<https://docs.public-api.monta.com>. Monta is a trademark of its owner; this
integration is not affiliated with Monta.
