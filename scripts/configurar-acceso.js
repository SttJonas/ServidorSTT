// Genera el hash local del administrador y guarda secretos fuera del código.
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { existsSync, chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { crearHashContrasena } from "../src/servicios/autenticacion.js";

const rutaEntorno = resolve(process.cwd(), ".env");
const stdin = process.stdin;
const stdout = process.stdout;

// Lee texto normal para el nombre de usuario.
function preguntar(pregunta) {
  const interfaz = createInterface({ input: stdin, output: stdout });
  return new Promise((resolver) => interfaz.question(pregunta, (respuesta) => {
    interfaz.close();
    resolver(respuesta.trim());
  }));
}

// Lee una contraseña sin mostrar los caracteres escritos en la terminal.
function preguntarSecreto(pregunta) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Ejecuta este asistente directamente en una terminal interactiva.");
  }

  return new Promise((resolver, rechazar) => {
    let secreto = "";
    stdout.write(pregunta);
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    function restaurar() {
      stdin.removeListener("keypress", alPresionarTecla);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    }

    function alPresionarTecla(caracter, tecla) {
      if (tecla?.ctrl && tecla.name === "c") {
        restaurar();
        rechazar(new Error("Configuración cancelada."));
      } else if (tecla?.name === "return" || tecla?.name === "enter") {
        restaurar();
        resolver(secreto);
      } else if (tecla?.name === "backspace") {
        secreto = secreto.slice(0, -1);
      } else if (!tecla?.ctrl && !tecla?.meta) {
        secreto += caracter;
      }
    }

    stdin.on("keypress", alPresionarTecla);
  });
}

// Verifica que la configuración nueva no reemplace secretos existentes.
if (existsSync(rutaEntorno)) {
  throw new Error("Ya existe .env; consérvalo y edítalo manualmente si necesitas cambiar la cuenta.");
}

const usuario = await preguntar("Nombre del administrador [admin]: ") || "admin";
if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(usuario)) {
  throw new Error("El usuario debe usar letras, números, punto, guion o guion bajo.");
}

const publicarConHttps = (await preguntar("¿El panel se publicará mediante HTTPS? [S/n]: "))
  .toLowerCase() !== "n";
const contrasena = await preguntarSecreto("Nueva contraseña (mínimo 14 caracteres): ");
const confirmacion = await preguntarSecreto("Repite la contraseña: ");
if (contrasena.length < 14) {
  throw new Error("La contraseña debe tener al menos 14 caracteres.");
}
if (contrasena !== confirmacion) {
  throw new Error("Las contraseñas no coinciden.");
}

// Calcula un hash scrypt con sal aleatoria para que el secreto no sea reversible.
const hashConfigurado = await crearHashContrasena(contrasena);
const contenido = [
  "PUERTO=3000",
  `ENTORNO=${publicarConHttps ? "produccion" : "desarrollo"}`,
  `COOKIE_SECURE=${publicarConHttps}`,
  `ADMIN_USERNAME=${usuario}`,
  `ADMIN_PASSWORD_HASH=${hashConfigurado}`,
  `CUENTAS_API_SECRETO=${randomBytes(32).toString("hex")}`,
  "",
].join("\n");

// Crea el archivo exclusivamente para el usuario actual y limita permisos en Debian.
writeFileSync(rutaEntorno, contenido, { flag: "wx", mode: 0o600 });
try {
  chmodSync(rutaEntorno, 0o600);
} catch (error) {
  if (process.platform !== "win32") throw error;
}
console.log("Configuración segura creada en .env. No compartas ese archivo ni su contenido.");
