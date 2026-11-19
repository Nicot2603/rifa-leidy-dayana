# Gran Rifa Solidaria · Leidy Dayana

Tablero compartido para la rifa solidaria.

- **Premio:** $200.000
- **Boleta:** $10.000
- **Números:** 100 (00 al 99)
- **Sorteo:** sábado 21 de noviembre de 2026
- **Sitio:** https://rifa-leidy-dayana.vercel.app

## Cómo funciona

Toca un número libre, escribe tu nombre y el número queda tapado con tu nombre.
El tablero es compartido: todos ven el mismo estado y se actualiza cada pocos segundos.

- **Pago:** Nequi **311 275 6483** o llave **@3112756483**.
- **Panel privado:** https://rifa-leidy-dayana.vercel.app/panel-leidy-x7k29q.html
  (enlace aparte, sin clave; solo lo tiene Leidy). Desde ahí se ve lo recaudado, se marcan
  pagos y se liberan números.
- El tablero público no permite liberar, marcar pagos ni editar nombres: el servidor
  rechaza esas acciones sin la llave interna del panel.
- `index.html` — la app pública (una sola página, sin frameworks).
- `panel-leidy-x7k29q.html` — el panel privado.
- `api/board.js` — función de Vercel que lee y guarda el tablero en Vercel Blob.
- `package.json` — dependencia `@vercel/blob`.

Cada `git push` a `main` se publica automáticamente en Vercel.
