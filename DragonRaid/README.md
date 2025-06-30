# 🛡️ DragonRaid Anti-Raid System

Sistema avanzado de protección automática para servidores Minecraft Bedrock. Detecta y bloquea raids, spam de TNT, entidades hostiles, hacks de movimiento y falsos positivos, todo en tiempo real.

---

## 🚀 Características principales
- **Protección automática contra raids de TNT y mobs hostiles**
- **Bloqueo y limpieza de entidades peligrosas**
- **Sistema anti-speed/teleport hacks avanzado**
- **Prevención de falsos positivos (aprende el comportamiento de cada jugador)**
- **Comandos informativos rápidos vía `/function`**
- **Mensajes claros y alertas en el chat**

---

## 📦 Instalación
1. Copia la carpeta `BP/` en la carpeta de behavior packs de tu mundo/servidor.
2. Activa el pack en la configuración del mundo.
3. Asegúrate de tener activada la API de scripts experimentales.
4. (Opcional) Personaliza los archivos `.mcfunction` en `BP/functions/` para tus necesidades.

---

## 📝 Comandos disponibles (`/function`)

- `/function antiraid_help` — Lista y explica todos los comandos anti-raid.
- `/function antiraid_status` — Estado general del sistema y consejos.
- `/function antiraid_tnt` — Estado y recomendaciones sobre TNT.
- `/function antiraid_movement` — Explicación del sistema anti-speed/teleport.

Todos los comandos son informativos y seguros de usar. No ejecutan acciones peligrosas.

---

## ⚙️ ¿Cómo funciona?
- El script `antiRaid.js` detecta automáticamente raids, spam de TNT, mobs hostiles, hacks de movimiento y falsos positivos.
- Si detecta abuso, limpia entidades peligrosas y bloquea el spawn temporalmente.
- Los comandos `/function` solo muestran información y consejos útiles.

---

## 🛠️ Personalización
- Puedes editar los archivos `.mcfunction` en `BP/functions/` para cambiar los mensajes o agregar comandos vanilla útiles.
- Para lógica avanzada, modifica el script `BP/scripts/antiRaid.js`.

---

## 🧑‍💻 Autor y soporte
- Desarrollado por Hydra y comunidad.
- ¿Dudas o sugerencias? Abre un issue o contacta por Discord.

---

**¡Disfruta de tu servidor protegido y sin raids!** 