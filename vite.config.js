import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // The happy-dom tests (cleanHTML, input) parse fixture HTML with
    // <link rel="stylesheet"> and <script src>. happy-dom would otherwise
    // eagerly fetch those against its default localhost:3000 origin — real
    // network attempts + ECONNREFUSED noise inside unit tests. Disable resource
    // loading and treat the disabled load as success so no error event fires.
    // (Iframes are handled at the fixture level — see cleanHTML.test.js — since
    // disableIframePageLoading logs on every iframe, even a src-less about:blank.)
    environmentOptions: {
      happyDOM: {
        settings: {
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
  },
});
