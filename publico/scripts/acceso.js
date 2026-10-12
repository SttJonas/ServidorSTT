const formulario = document.querySelector("#formulario-acceso");
const boton = document.querySelector("#boton-acceso");
const error = document.querySelector("#mensaje-error");

fetch("/api/autenticacion/sesion")
  .then((respuesta) => respuesta.json())
  .then((sesion) => {
    if (sesion.autenticado) window.location.replace("/");
  })
  .catch(() => {
    error.textContent = "No se pudo comprobar la sesión. Recarga la página.";
  });

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  boton.disabled = true;
  error.textContent = "";
  try {
    const respuesta = await fetch("/api/autenticacion/iniciar-sesion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usuario: formulario.usuario.value,
        contrasena: formulario.contrasena.value,
      }),
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.mensaje || "No se pudo iniciar sesión.");
    window.location.assign("/");
  } catch (fallo) {
    error.textContent = fallo.message;
    formulario.contrasena.value = "";
    formulario.contrasena.focus();
  } finally {
    boton.disabled = false;
  }
});
