# Third-party licences

## battlecast-engine (MIT)

Project: https://github.com/bjedrzejewski/battlecast-engine
Commit vendored from: `ffe036c758f18e772a808f538fe3baa845b9bcc0`

`src/combat/vendor/` contains three adapted files from that project: the grid geometry helpers
(`src/engine/combat-geometry.ts`), the Bresenham line-of-sight check (`src/types/terrain.ts`) and the
A* pathfinder (`findPath` from `src/engine/ai-movement.ts`). Nothing else was copied.

```
MIT License

Copyright (c) 2026 Bartosz Jedrzejewski

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

The bundled SRD 5.2.1 data has its own attribution in `srd/ATTRIBUTION.md`.
