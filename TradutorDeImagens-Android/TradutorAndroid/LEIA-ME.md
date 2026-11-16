# Tradutor de Imagens ao Vivo — Android (WebView)

App com navegador embutido (WebView) que traduz o texto das imagens direto no site
(mangá, manhwa, comics), por cima da própria imagem. Mesma lógica da extensão.

## Gerar o APK (sem Android Studio)
1. Crie um repositório no GitHub e envie TODO o conteúdo desta pasta (incluindo `.github`).
2. Abra a aba **Actions** > "Build APK" > **Run workflow** (ou ele roda sozinho no push).
3. Quando terminar, baixe o artefato **TradutorDeImagens-apk**, extraia o zip e instale o `.apk`
   (permita "instalar apps de fontes desconhecidas").

## Gerar com Android Studio
Abra a pasta, deixe sincronizar e use Build > Build APK(s).

## Como usar
- Digite o endereço do site (ou pesquise) e navegue normalmente.
- **Ajustes**: ligue "Traduzir automaticamente em este site", escolha idiomas e a chave do OCR.space.
- **Traduzir**: traduz as imagens da página. **Original/Alternar**: mostra/oculta. **Limpar**: remove.
- Segure o dedo numa imagem > "Traduzir esta imagem".
- Botão "T" no canto de cada imagem alterna original/tradução.
