# Peak

**En producción:** <https://notas-faltas-giovanni.netlify.app>

> El proyecto de Netlify mantiene el nombre `notas-faltas-giovanni` para no cambiar la URL.

Peak es una app web para gestionar las materias de tu curso: exámenes, trabajos y faltas, con la nota final calculada automáticamente.

- **Sin registro**, sin servidor y sin base de datos.
- Los datos se guardan en el **almacenamiento local del navegador** (`localStorage`).
- Funciona en móvil y escritorio, con **tema claro y oscuro**.

## Tipos de materia

Cada materia se puede evaluar de tres formas:

| Tipo | Cómo cuenta |
| --- | --- |
| **Exámenes** | Solo las pruebas |
| **Trabajos** | Solo las entregas |
| **Exámenes + trabajos** | Mixto, con el peso que elijas |

Dentro de una materia, cada evaluación es un **examen** o un **trabajo**. Si la materia es de un solo tipo, la app fija automáticamente el tipo de evaluación.

## Cómo se calcula la nota

**Modo "Exámenes + Trabajos"**

```
media exámenes = Σ(nota × peso) / Σ(pesos de exámenes)
media trabajos = Σ(nota × peso) / Σ(pesos de trabajos)
nota final     = media exámenes × (peso exámenes/100) + media trabajos × (peso trabajos/100)
```

**Modo "Solo exámenes"**: la nota final es la media ponderada de los exámenes.

**Modo "Solo trabajos"**: la nota final es la media ponderada de los trabajos.

Los pesos de exámenes y trabajos se configuran en **materia → Ajustes** y deben sumar 100 %.
Si una de las dos partes no tiene elementos, la nota final usa solo la parte que sí tiene datos.

## Faltas

En **Ajustes** de cada materia defines:

- **Total de clases del curso** (para calcular los porcentajes).
- **Límite de faltas justificadas (%)**.
- **Límite de faltas injustificadas (%)**.

La app convierte esos porcentajes en número de faltas permitidas y avisa cuando te pasas.

## Copias de seguridad

- **Exportar**: descarga un `.json` con todas tus materias.
- **Importar**: permite reemplazar los datos actuales o añadir las materias del archivo.

> El almacenamiento local es **por navegador y por dispositivo**. Si borras los datos del navegador, pierdes la información: exporta de vez en cuando.

## Publicar en Netlify (gratis)

El sitio ya está publicado: <https://notas-faltas-giovanni.netlify.app> (proyecto `notas-faltas-giovanni`).

### Actualizar la web

1. Entra en <https://app.netlify.com/projects/notas-faltas-giovanni/overview> con tu cuenta.
2. Arrastra la carpeta `NotasFaltas` (o el `.zip` con `index.html`, `style.css`, `app.js`) sobre la zona de drop de la página del proyecto.
3. Netlify publica los cambios en la misma URL en unos segundos.

> Netlify exige tener cuenta para usar Drop. La web es pública y gratuita.

### Opción CLI

```bash
cd NotasFaltas
npx netlify-cli login
npx netlify-cli deploy --prod --dir .
```

El archivo `netlify.toml` indica que se publica la carpeta actual (`publish = "."`) e incluye cabeceras de seguridad.

### Cambiar la URL

En el proyecto: **Project configuration → General → Change project name**. El nombre del proyecto es el subdominio `*.netlify.app`.

## Estructura

| Archivo | Contenido |
| --- | --- |
| `index.html` | Estructura, modales y textos |
| `style.css` | Diseño (tema claro/oscuro) y responsive |
| `app.js` | Estado, cálculos y guardado en `localStorage` |
| `netlify.toml` | Configuración de despliegue y cabeceras |

## Añadir a la pantalla de inicio del móvil

- **Android/Chrome**: menú ⋮ → *Añadir a pantalla de inicio*.
- **iPhone/Safari**: botón compartir → *Añadir a pantalla de inicio*.

Se abre a pantalla completa como si fuera una app.
