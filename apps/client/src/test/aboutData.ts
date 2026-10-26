/** Source order of the verbatim legal bodies rendered by About. */
export const aboutLegalFiles = [
  'LICENSE',
  'packages/mosh-transport/vendor/COPYING.iOS',
  'packages/mosh-transport/vendor-android/protobuf/LICENSE',
  'packages/mosh-transport/vendor-android/protobuf/third_party/utf8_range/LICENSE',
  'packages/mosh-transport/vendor-android/abseil/LICENSE',
  'packages/mosh-transport/OPENSSL-LICENSE.txt',
  'packages/et-transport/LICENSE-MIT',
  'packages/portable-pty-vendor/LICENSE.md',
] as const;
export const aboutLocales = [
  {locale:'en',region:'About lazysh',source:'View corresponding source and build history',license:'License: Protocol Buffers'},
  {locale:'pt-BR',region:'Sobre o lazysh',source:'Ver o código-fonte correspondente e o histórico da compilação',license:'Licença: Protocol Buffers'},
  {locale:'es',region:'Acerca de lazysh',source:'Ver el código fuente correspondiente y el historial de compilación',license:'Licencia: Protocol Buffers'},
] as const;
