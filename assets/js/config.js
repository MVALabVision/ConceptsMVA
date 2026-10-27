// Site configuration. No secrets live here — this file is public.
// The admin token is entered in the browser at sign-in and is never written to the repository.
export const CONFIG = Object.freeze({
  owner: 'MVALabVision',
  repo: 'ConceptsMVA',
  branch: 'main',
  siteName: 'MVA Lab — Concept Studio',
  // Public base URL of the deployed site. Leave null to derive it from the current page
  // (e.g. https://mvalabvision.github.io/ConceptsMVA/). Set explicitly if you use a custom domain.
  publicBase: null,
  limits: Object.freeze({
    maxPackageBytes: 30 * 1024 * 1024,   // uploaded HTML or ZIP file size
    maxFileBytes: 25 * 1024 * 1024,      // any single file inside a ZIP
    maxUnzippedBytes: 80 * 1024 * 1024,  // total size after extraction
    maxFiles: 1500,                      // entries per ZIP
    maxThumbBytes: 8 * 1024 * 1024,      // thumbnail source image
  }),
  deploy: Object.freeze({
    timeoutMs: 8 * 60 * 1000,
    intervalMs: 5000,
  }),
});
