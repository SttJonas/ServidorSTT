const token = new URLSearchParams(window.location.search).get("token") ?? "";
const formulario = document.querySelector("#formulario-registro");
const titulo = document.querySelector("#titulo-registro");
const descripcion = document.querySelector("#descripcion-registro");
const error = document.querySelector("#error-registro");
const boton = document.querySelector("#boton-registro");
let invitacionValida = false;

async function consultarInvitacion() {
  try {
    const respuesta = await fetch(`/api/autenticacion/invitaciones/${encodeURIComponent(token)}`);
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "La invitación no es válida o venció.");
    invitacionValida = true;
    titulo.textContent = "Crear cuenta";
    const rol = resultado.rol === "administrador" ? "Administrador" : "Operador";
    const permisos = resultado.rol === "administrador"
      ? "tendrá acceso a todos los proyectos y a la gestión de cuentas"
      : "podrá gestionar sus propios proyectos";
    descripcion.textContent = `Invitación para ${resultado.usuario}. Rol: ${rol}; ${permisos}.`;
    document.querySelector("#usuario-registro").value = resultado.usuario;
    formulario.classList.remove("oculto");
  } catch (fallo) {
    titulo.textContent = "No se pudo validar la invitación";
    descripcion.textContent = fallo.message;
    document.querySelector("#enlace-iniciar-sesion").classList.remove("oculto");
  }
}

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  error.textContent = "";
  const contrasena = document.querySelector("#contrasena-registro").value;
  if (!invitacionValida) {
    error.textContent = "La invitación no es válida. Solicita otra al administrador.";
    return;
  }
  if (contrasena !== document.querySelector("#confirmar-contrasena-registro").value) {
    error.textContent = "Las contraseñas no coinciden.";
    return;
  }
  boton.disabled = true;
  try {
    const respuesta = await fetch("/api/autenticacion/aceptar-invitacion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        nombre: document.querySelector("#nombre-registro").value,
        contrasena,
      }),
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo crear la cuenta.");
    window.location.replace("/");
  } catch (fallo) {
    error.textContent = fallo.message;
    boton.disabled = false;
  }
});

void consultarInvitacion();
