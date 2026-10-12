// Carga el archivo local antes de validar la configuración, sin reemplazar
// variables que ya haya inyectado Docker o el entorno del proceso.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rutaArchivoEntorno = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(rutaArchivoEntorno)) {
  const lineas = readFileSync(rutaArchivoEntorno, "utf8").split(/\r?\n/);
  for (const linea of lineas) {
    const entrada = linea.trim();
    if (!entrada || entrada.startsWith("#")) continue;
    const separador = entrada.indexOf("=");
    if (separador < 1) continue;
    const nombre = entrada.slice(0, separador).trim();
    const valor = entrada.slice(separador + 1).trim();
    if (process.env[nombre] === undefined) process.env[nombre] = valor;
  }
}

// Lee las variables de entorno y aplica valores seguros para el desarrollo.
const puerto = Number.parseInt(process.env.PUERTO ?? "3000", 10);

// Rechaza un puerto inválido para evitar que el servidor falle más adelante.
if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
  throw new Error("La variable PUERTO debe ser un número entre 1 y 65535.");
}

// Exporta una configuración única para que el resto de la aplicación no lea
// directamente process.env en varios lugares.
export const entorno = Object.freeze({
  puerto,
  modo: process.env.ENTORNO ?? "desarrollo",
  usuarioAdministrador: process.env.ADMIN_USERNAME ?? "",
  hashContrasenaAdministrador: process.env.ADMIN_PASSWORD_HASH ?? "",
  cookieSegura: process.env.COOKIE_SECURE === "true",
  archivoUsuarios: process.env.ARCHIVO_USUARIOS ?? "./datos/usuarios.json",
  cuentasApiSecreto: process.env.CUENTAS_API_SECRETO ?? "",
});

// Exige una cuenta y un hash válidos antes de iniciar el panel administrativo.
if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(entorno.usuarioAdministrador)) {
  throw new Error("ADMIN_USERNAME debe tener entre 1 y 32 caracteres válidos.");
}
if (!/^scrypt:32768:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(entorno.hashContrasenaAdministrador)) {
  throw new Error("ADMIN_PASSWORD_HASH no tiene el formato seguro generado por npm run configurar-acceso.");
}
if (entorno.modo === "produccion" && !entorno.cookieSegura) {
  throw new Error("COOKIE_SECURE debe ser true en producción para proteger la sesión HTTPS.");
}
if (!/^[a-f0-9]{64}$/.test(entorno.cuentasApiSecreto)) {
  throw new Error("CUENTAS_API_SECRETO debe ser un secreto hexadecimal de 64 caracteres generado con npm run configurar-cuentas-php.");
}
