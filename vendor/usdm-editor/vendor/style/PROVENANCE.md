# vendor/style — provenance

A **fork**, not a copy. Source:

- Upstream: https://github.com/sustainable-fsa/style
- Version:  v0.2.0
- Upstream commit: e497f626e0de1cd6126278f65cb24461e6a12064
- Vendored:  2026-08-20
- License:   MIT, © Montana Climate Office (see LICENSE) — same org as NGP RIDR.

Upstream lineage: `sustainable-fsa/style` is itself a re-skin of
`mt-climate-office/mco-web-style`; the layer order, token contract, z-index
ladder, breakpoint ladder and component anatomy come from there.

## What this fork changes

1. **Class namespace** `.sfsa-*` → `.ridr-*`, and `theme/sfsa-theme.css` →
   `theme/ridr-theme.css`. The localStorage theme key is `ridr-theme`.
2. **Design tokens** re-measured for NGP RIDR (prairie green / dry-grass amber /
   logo blue). Every contrast ratio in the theme's header comment was recomputed
   against this palette — none were carried over from the FSA numbers.
3. **Fonts**: the self-hosted Roboto variable face is REMOVED. NGP RIDR follows
   its own site's stack (`system-ui` / Georgia), so there is no `@font-face`,
   no `theme/fonts/` directory and no font preload.
4. `MANIFEST.sha256` from upstream is deleted — it describes upstream's bytes,
   and keeping it here would assert something false about these.

5. **`ui/export.js` takes logo URLs.** Upstream's `composeBranded` reads two
   fixed files from the kit's own `assets/` directory. This fork ships no such
   directory: the brand lives with the app in `brand/`, and copying a logo into
   the vendored kit would create a second copy to drift from the first. The
   `logos` option now accepts `{ banner: '<url>', mco: '<url>' }`, and anything
   falsy draws nothing. Intrinsic aspect ratios are read from the loaded image
   rather than hard-coded, since the images are no longer fixed.

6. **One added token: `--map-dim`.** Defined in both theme blocks of
   `theme/ridr-theme.css`, as an `rgba()` with its alpha baked in. Upstream has
   no such token because upstream's fleet has no working area to be outside of.
   The USDM Editor scopes every edit to a jurisdiction and paints everything
   OUTSIDE it with a mask (`aoiMask()` in `js/aoi.js`) — which is the only fill
   this app permits over a map carrying the USDM's fixed published ramp,
   precisely because it never lands on the ramp. An addition rather than a
   change: nothing upstream reads it, and a future upstream merge sees a new
   declaration, not a modified one.

7. **A second added token: `--z-tour` (300).** A rung of the stacking ladder in
   `theme/ridr-theme.css` § 2, between `--z-cursor` (200) and `--z-toast` (400).
   The USDM Editor's first-visit walkthrough (`js/tour.js`) spotlights the
   drawer, the docked card and the navbar in turn, so its callout has to clear
   every one of them and still sit under a toast. The ladder's own rule is "add
   to a tier — don't invent a number", and the tier did not exist: upstream's
   fleet has no walkthrough. Declared in the ladder rather than in `css/app.css`
   because the VALUE is a claim about these neighbours; a number chosen beside
   app layout cannot see them. An addition rather than a change, like
   `--map-dim` above: a future upstream merge sees a new declaration.

Everything else — `core/`, `map/`, `ui/`, `county/`, `snippets/` — is upstream
logic with only the namespace rename applied.

## Upstream manifest at fork time

```
fb9eadab09cfaed7bced94840b12dedb0f635fe305fcb83709ae1f5df50b5a70  core/core.js
358fe4b2b0bb87ac0e46131a7111ea32a2df6806bc23295679f8a968b414a9d5  county/county.js
4f930bb11ab1c94d6092dd191ce7c6a2d6148c1a2c69c4c8e4811a877760038d  map/map.js
ea068919b2a4796ed084d5d23311e8d9c98f788d762ffea08523e298f79c786d  snippets/anti-flash.html
adf86be161319ce5ef2b4327dad73751e0ea6c1f47ee49e8818f8d1758890e0f  snippets/head.html
c9610bd30e00426d8861778164d3f408a44bcffe243d77c737b4df246a8bea48  snippets/skip-link.html
0a44e0bb6ba5c8537e8814c148ef7755f1bce12112361231f595ecc584a18d7a  theme/fonts/roboto-v51-latin-wght.woff2
48d3ff1793732d415dca0b4172362c5461e41380b2f165015270baa941b95ea6  theme/sfsa-theme.css
49364c62dbfdc3d5fe7a8f6ab6f47e8f709381aadb64b82ca57f72b2b061a007  tokens/tokens.json
3da63f32b1b14d49e67d53dd3002d12426b0ff3d4ebd916bbfaf082b677fec56  ui/card.js
77cb130d94d8b6178cb2b72af1db5b9c192c0692b3a3e15035298ecf322c79da  ui/drawer.js
b7c64e3b6fff4a68066aaeca0ff473a6215e542222eb473eb06297a990a5a751  ui/export.js
c6b40a81273156bbfbb453b6648e19edd371018af2bdfa1f8b9e2595f692ffc9  ui/help.js
970e41b0c4da32873be11dcce92608f0f6351c2cb282d8228d3352fb74c3f01c  ui/legend.js
51db0e9856e15f5ad5aa1aae50c09766ac13eb21d95a78ceef9e7563174f8bfe  ui/search.js
8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c  vendor-esm/marked-18.0.10/LICENSE
4cf47dfebb7f614a08fc0a579ab0fe407ff0ed2b717bf953040c85b2f493a4f0  vendor-esm/marked-18.0.10/marked.esm.js
```
