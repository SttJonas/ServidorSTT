"""Pruebas de normalización de metadatos Docker publicados por el agente."""

import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import unittest
import http.client
from unittest.mock import patch
import uuid


RUTA_AGENTE = pathlib.Path(__file__).parents[1] / "agente" / "monitor_host.py"
ESPECIFICACION = importlib.util.spec_from_file_location("monitor_host", RUTA_AGENTE)
MONITOR_HOST = importlib.util.module_from_spec(ESPECIFICACION)
ESPECIFICACION.loader.exec_module(MONITOR_HOST)


class PruebasMetadatosContenedores(unittest.TestCase):
    """Verifica el contrato limitado de solo lectura para contenedores."""

    def test_red_incluye_gateway_dns_y_direcciones_de_interfaz(self):
        def ejecutar_falsa(argumentos):
            if argumentos[:4] == ["ip", "-j", "route", "show"]:
                return '[{"dev":"eth0","gateway":"192.0.2.1"}]'
            if argumentos[:4] == ["ip", "-j", "address", "show"]:
                return '[{"addr_info":[{"family":"inet","local":"192.0.2.4"},{"family":"inet6","local":"2001:db8::4"}]}]'
            self.fail(f"Consulta de red inesperada: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falsa),
            patch.object(MONITOR_HOST, "leer_dns", return_value=["192.0.2.53"]),
        ):
            red = MONITOR_HOST.leer_red()

        self.assertEqual(red["gateway"], "192.0.2.1")
        self.assertEqual(red["dns"], ["192.0.2.53"])
        self.assertEqual(red["ipv4"], "192.0.2.4")
        self.assertEqual(red["ipv6"], "2001:db8::4")

    def test_red_sin_ruta_predeterminada_no_interrumpe_el_monitor(self):
        with (
            patch.object(MONITOR_HOST, "ejecutar", return_value="[]"),
            patch.object(MONITOR_HOST, "leer_dns", return_value=[]),
        ):
            red = MONITOR_HOST.leer_red()

        self.assertFalse(red["disponible"])
        self.assertIsNone(red["interfaz"])
        self.assertEqual(red["dns"], [])

    def test_seguridad_normaliza_reglas_ufw_y_jails_fail2ban(self):
        respuestas = {
            ("/usr/sbin/ufw", "status", "verbose"): (
                "Status: active\nLogging: on\nTo Action From\n"
                "-- ------ ----\n22/tcp ALLOW IN Anywhere\n80/tcp ALLOW IN Anywhere\n"
            ),
            ("systemctl", "is-active", "ufw"): "active",
            ("systemctl", "is-active", "fail2ban"): "active",
            ("/usr/bin/fail2ban-client", "status"): "Status\nJail list: sshd, recidive",
            ("systemctl", "is-active", "ssh"): "active",
        }
        with patch.object(
            MONITOR_HOST,
            "ejecutar",
            side_effect=lambda argumentos: respuestas.get(tuple(argumentos)),
        ):
            seguridad = MONITOR_HOST.leer_seguridad()

        self.assertEqual(seguridad["ufw"], "activo")
        self.assertEqual(seguridad["ufwReglas"], ["22/tcp ALLOW IN Anywhere", "80/tcp ALLOW IN Anywhere"])
        self.assertEqual(seguridad["fail2ban"], "activo")
        self.assertEqual(seguridad["fail2banJails"], ["sshd", "recidive"])
        self.assertEqual(seguridad["ssh"], "activo · puerto 22")

    def test_nombre_personalizado_de_base_se_valida_en_el_agente(self):
        solicitud = {
            "accion": "crear_base_datos",
            "id": "01234567-89ab-4cde-8fab-0123456789ab",
            "nombreConfirmado": "Proyecto",
            "motor": "postgresql",
            "nombreBaseDatos": "inventario_app",
        }
        validada, error = MONITOR_HOST.validar_solicitud_base_datos(solicitud)
        self.assertIsNone(error)
        self.assertEqual(validada, (
            solicitud["id"],
            "Proyecto",
            "postgresql",
            "inventario_app",
        ))

        solicitud["nombreBaseDatos"] = "x; DROP DATABASE swatt;"
        validada, error = MONITOR_HOST.validar_solicitud_base_datos(solicitud)
        self.assertIsNone(validada)
        self.assertIsNotNone(error)

    def test_seguridad_conserva_estado_de_servicios_si_no_puede_leer_reglas_o_jails(self):
        respuestas = {
            ("systemctl", "is-active", "ufw"): "active",
            ("systemctl", "is-active", "fail2ban"): "active",
        }
        with patch.object(
            MONITOR_HOST,
            "ejecutar",
            side_effect=lambda argumentos: respuestas.get(tuple(argumentos)),
        ):
            seguridad = MONITOR_HOST.leer_seguridad()

        self.assertEqual(seguridad["ufw"], "activo")
        self.assertEqual(seguridad["ufwReglas"], [])
        self.assertEqual(seguridad["fail2ban"], "activo")
        self.assertEqual(seguridad["fail2banJails"], [])

    def test_mantenimiento_no_disponible_no_inventa_tiempo_activo(self):
        with (
            patch("builtins.open", side_effect=OSError("sin /proc/uptime")),
            patch.object(MONITOR_HOST.os.path, "exists", return_value=True),
            patch.object(MONITOR_HOST, "leer_swap", return_value={"disponible": False}),
        ):
            mantenimiento = MONITOR_HOST.leer_mantenimiento()

        self.assertIsNone(mantenimiento["tiempoActivoSegundos"])
        self.assertTrue(mantenimiento["reinicioNecesario"])
        self.assertEqual(mantenimiento["swap"], {"disponible": False})


    def test_normaliza_los_campos_publicados_por_docker(self):
        salida = (
            '{"ID":"abc123","Names":"panel","Image":"swatt:latest",'
            '"Status":"Up 4 minutes","Ports":"127.0.0.1:3000->3000/tcp",'
            '"CreatedAt":"2026-09-30 02:00:00 +0000 UTC"}\n'
        )

        self.assertEqual(
            MONITOR_HOST.normalizar_contenedores(salida),
            [{
                "id": "abc123",
                "nombre": "panel",
                "imagen": "swatt:latest",
                "estado": "Up 4 minutes",
                "puertos": "127.0.0.1:3000->3000/tcp",
                "creado": "2026-09-30 02:00:00 +0000 UTC",
                "ejecutando": False,
                "administrable": True,
            }],
        )

    def test_limita_la_longitud_de_los_campos_de_docker(self):
        salida = (
            '{"ID":"' + ("i" * 80) + '","Names":"' + ("n" * 200)
            + '","Image":"' + ("x" * 300) + '","Status":"' + ("s" * 140)
            + '","Ports":"' + ("p" * 600) + '","CreatedAt":"' + ("d" * 80) + '"}'
        )

        contenedor = MONITOR_HOST.normalizar_contenedores(salida)[0]

        self.assertEqual(len(contenedor["id"]), 16)
        self.assertEqual(len(contenedor["nombre"]), 128)
        self.assertEqual(len(contenedor["imagen"]), 256)
        self.assertEqual(len(contenedor["estado"]), 128)
        self.assertEqual(len(contenedor["puertos"]), 512)
        self.assertEqual(len(contenedor["creado"]), 64)
        self.assertFalse(contenedor["ejecutando"])
        self.assertTrue(contenedor["administrable"])

    def test_lista_vacia_se_representa_sin_contenedores(self):
        self.assertEqual(MONITOR_HOST.normalizar_contenedores(""), [])

    def test_rechaza_operaciones_arbitrarias(self):
        contenedores = [{
            "ID": "0123456789abcdef",
            "Names": "aplicacion",
            "State": "running",
            "Labels": "",
        }]

        resultado, error = MONITOR_HOST.validar_solicitud_accion({
            "accion": "exec",
            "id": "0123456789ab",
            "nombreConfirmado": "aplicacion",
        }, contenedores)

        self.assertIsNone(resultado)
        self.assertEqual(error, "acción no permitida")

    def test_protege_el_contenedor_del_panel(self):
        contenedores = [{
            "ID": "0123456789abcdef",
            "Names": "panel",
            "State": "running",
            "Labels": "com.docker.compose.service=panel",
        }]

        resultado, error = MONITOR_HOST.validar_solicitud_accion({
            "accion": "detener",
            "id": "0123456789ab",
            "nombreConfirmado": "panel",
        }, contenedores)

        self.assertIsNone(resultado)
        self.assertEqual(error, "el contenedor del panel está protegido")

    def test_exige_confirmar_nombre_y_estado_actual(self):
        contenedores = [{
            "ID": "0123456789abcdef",
            "Names": "aplicacion",
            "State": "running",
            "Labels": "",
        }]

        solicitud = {
            "accion": "detener",
            "id": "0123456789ab",
            "nombreConfirmado": "otro-nombre",
        }
        resultado, error = MONITOR_HOST.validar_solicitud_accion(solicitud, contenedores)
        self.assertIsNone(resultado)
        self.assertEqual(error, "el nombre de confirmación no coincide")

        solicitud["nombreConfirmado"] = "aplicacion"
        resultado, error = MONITOR_HOST.validar_solicitud_accion(solicitud, contenedores)
        self.assertEqual(resultado, ("detener", "0123456789abcdef", "aplicacion"))
        self.assertIsNone(error)

    def test_rechaza_ids_ambiguos_y_estados_incompatibles(self):
        contenedores = [
            {"ID": "0123456789abcdef", "Names": "uno", "State": "running", "Labels": ""},
            {"ID": "0123456789ab9999", "Names": "dos", "State": "running", "Labels": ""},
        ]

        ambiguo, error_ambiguo = MONITOR_HOST.validar_solicitud_accion({
            "accion": "detener",
            "id": "0123456789ab",
            "nombreConfirmado": "uno",
        }, contenedores)
        iniciado, error_estado = MONITOR_HOST.validar_solicitud_accion({
            "accion": "iniciar",
            "id": "0123456789abcdef",
            "nombreConfirmado": "uno",
        }, contenedores)

        self.assertIsNone(ambiguo)
        self.assertEqual(error_ambiguo, "contenedor inexistente o identificador ambiguo")
        self.assertIsNone(iniciado)
        self.assertEqual(error_estado, "el contenedor ya está iniciado")

    def test_protege_runtimes_php_de_las_acciones_genericas_docker(self):
        contenedores = [{
            "ID": "0123456789abcdef",
            "Names": "swatt-php-aplicacion",
            "State": "running",
            "Labels": "com.swatt.managed=php-project,com.swatt.project-id=01234567-89ab-4cde-8fab-0123456789ab",
        }]

        resultado, error = MONITOR_HOST.validar_solicitud_accion({
            "accion": "detener",
            "id": "0123456789ab",
            "nombreConfirmado": "swatt-php-aplicacion",
        }, contenedores)

        self.assertIsNone(resultado)
        self.assertEqual(error, "los proyectos PHP se administran desde Proyectos")

    def test_permite_controles_docker_limitados_en_bases_de_datos(self):
        contenedores = [{
            "ID": "0123456789abcdef",
            "Names": "swatt-db-aplicacion",
            "State": "running",
            "Labels": "com.swatt.managed=database,com.swatt.project-id=01234567-89ab-4cde-8fab-0123456789ab",
        }]

        resultado, error = MONITOR_HOST.validar_solicitud_accion({
            "accion": "detener",
            "id": "0123456789ab",
            "nombreConfirmado": "swatt-db-aplicacion",
        }, contenedores)

        self.assertEqual(resultado, ("detener", "0123456789abcdef", "swatt-db-aplicacion"))
        self.assertIsNone(error)


class PruebasDesplieguePhp(unittest.TestCase):
    """Verifica el runtime PHP fijo, el alcance y los límites de recursos."""

    def setUp(self):
        self.directorio_temporal = tempfile.TemporaryDirectory()
        self.addCleanup(self.directorio_temporal.cleanup)
        self.id_proyecto = str(uuid.uuid4())
        self.nombre = "Proyecto PHP de prueba"
        self.directorio_proyectos = pathlib.Path(self.directorio_temporal.name)
        self.ruta_proyecto = self.directorio_proyectos / self.id_proyecto
        self.ruta_proyecto.mkdir()
        (self.ruta_proyecto / "index.php").write_text("<?php echo 'hola';", encoding="utf-8")
        (self.ruta_proyecto / ".git").mkdir()
        (self.ruta_proyecto / ".git" / "config").write_text("privado", encoding="utf-8")
        self.ruta_registro = self.directorio_proyectos / ".registro-swatt.json"
        self.ruta_registro.write_text(json.dumps([{
            "id": self.id_proyecto,
            "nombre": self.nombre,
            "repositorio": "https://github.com/ejemplo/proyecto.git",
            "rama": "main",
            "commit": "0123456789ab",
            "archivosCompose": [],
            "estado": "pendiente_revision",
            "creado": "2026-09-30T00:00:00.000Z",
        }]), encoding="utf-8")
        otro_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        registro = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        registro.append({
            "id": otro_id,
            "nombre": "PHP ya desplegado",
            "repositorio": "https://github.com/ejemplo/otro.git",
            "rama": "main",
            "commit": "abcdef012345",
            "archivosCompose": [],
            "estado": "desplegado",
            "runtime": MONITOR_HOST.IMAGEN_PHP_APACHE,
            "puertoLocal": MONITOR_HOST.PUERTO_PHP_INICIAL,
            "contenedor": f"swatt-php-{otro_id.replace('-', '')[:12]}",
            "creado": "2026-09-30T00:00:00.000Z",
        })
        self.ruta_registro.write_text(json.dumps(registro), encoding="utf-8")

    def test_rechaza_solicitudes_arbitrarias_y_confirmacion_incorrecta(self):
        self.assertEqual(
            MONITOR_HOST.validar_solicitud_despliegue({"accion": "docker_compose", "id": self.id_proyecto}),
            (None, "acción de despliegue no permitida"),
        )
        solicitud = {
            "accion": "desplegar_php",
            "id": self.id_proyecto,
            "nombreConfirmado": "Otro proyecto",
        }
        with patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos), patch.object(
            MONITOR_HOST, "ejecutar"
        ) as ejecutar:
            resultado = MONITOR_HOST.ejecutar_despliegue_php(solicitud)
        self.assertFalse(resultado["correcto"])
        self.assertIn("confirmación", resultado["mensaje"])
        ejecutar.assert_not_called()

    def test_despliega_runtime_fijo_con_fuente_solo_lectura_y_publicacion_local(self):
        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{.Id}}"]:
                return None
            if argumentos[:4] == ["docker", "image", "inspect", "--format"]:
                return "sha256:imagen-fija"
            if argumentos[:4] == ["docker", "network", "inspect", "--format"]:
                return self.id_proyecto
            if argumentos[:2] == ["docker", "ps"]:
                return ""
            if argumentos[:4] == ["docker", "inspect", "--format", "{{.State.Running}}"]:
                return "true"
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return json.dumps({
                    "State": {"Running": True},
                    "Config": {
                        "Image": MONITOR_HOST.IMAGEN_PHP_APACHE,
                        "Labels": {
                            "com.swatt.managed": "php-project",
                            "com.swatt.project-id": self.id_proyecto,
                        },
                    },
                    "NetworkSettings": {
                        "Networks": {
                            f"{MONITOR_HOST.NOMBRE_RED_PHP}{self.id_proyecto.replace('-', '')[:12]}": {
                                "IPAddress": "172.19.0.2",
                            },
                        },
                    },
                })
            self.fail(f"Consulta Docker no esperada: {argumentos}")

        def ejecutar_subproceso(argumentos, **opciones):
            return subprocess.CompletedProcess(argumentos, 0, "a" * 64, "")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "DIRECTORIO_SECRETOS", self.directorio_proyectos / "secretos"),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
            patch.object(MONITOR_HOST.subprocess, "run", side_effect=ejecutar_subproceso) as ejecutar_real,
            patch.object(MONITOR_HOST, "iniciar_proxy_php") as iniciar_proxy,
        ):
            resultado = MONITOR_HOST.ejecutar_despliegue_php({
                "accion": "desplegar_php",
                "id": self.id_proyecto,
                "nombreConfirmado": self.nombre,
            })

        self.assertTrue(resultado["correcto"])
        self.assertEqual(resultado["puerto"], MONITOR_HOST.PUERTO_PHP_INICIAL + 1)
        comando = ejecutar_real.call_args.args[0]
        self.assertIn(MONITOR_HOST.IMAGEN_PHP_APACHE, comando)
        self.assertIn("--read-only", comando)
        self.assertIn("--cap-drop", comando)
        self.assertNotIn("--publish", comando)
        self.assertTrue(any("readonly" in argumento and str(self.ruta_proyecto) in argumento for argumento in comando))
        iniciar_proxy.assert_called_once_with(self.id_proyecto, MONITOR_HOST.PUERTO_PHP_INICIAL + 1, "172.19.0.2")
        self.assertFalse((self.ruta_proyecto / ".git").exists())
        registro_actualizado = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        self.assertEqual(registro_actualizado[0]["estado"], "desplegado")
        self.assertEqual(registro_actualizado[0]["puertoLocal"], MONITOR_HOST.PUERTO_PHP_INICIAL + 1)
        if os.name == "posix":
            self.assertEqual(self.ruta_registro.stat().st_mode & 0o777, 0o600)

    def test_exige_index_php_regular_antes_de_usar_docker(self):
        (self.ruta_proyecto / "index.php").unlink()
        with patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos), patch.object(
            MONITOR_HOST, "ejecutar"
        ) as ejecutar:
            resultado = MONITOR_HOST.ejecutar_despliegue_php({
                "accion": "desplegar_php",
                "id": self.id_proyecto,
                "nombreConfirmado": self.nombre,
            })
        self.assertFalse(resultado["correcto"])
        self.assertIn("index.php", resultado["mensaje"])
        ejecutar.assert_not_called()

    def convertir_en_runtime(self, estado="activo"):
        registro = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        registro[0].update({
            "estado": "desplegado",
            "runtime": MONITOR_HOST.IMAGEN_PHP_APACHE,
            "puertoLocal": MONITOR_HOST.PUERTO_PHP_INICIAL + 2,
            "contenedor": f"swatt-php-{self.id_proyecto.replace('-', '')[:12]}",
            "idContenedor": "b" * 64,
            "estadoRuntime": estado,
        })
        self.ruta_registro.write_text(json.dumps(registro), encoding="utf-8")

    def inspeccion_php(self, ejecutando):
        return json.dumps({
            "State": {"Running": ejecutando},
            "Mounts": [{
                "Destination": "/run/secrets/database-url",
                "RW": False,
            }],
            "Config": {
                "Image": MONITOR_HOST.IMAGEN_PHP_APACHE,
                "Labels": {
                    "com.swatt.managed": "php-project",
                    "com.swatt.project-id": self.id_proyecto,
                },
            },
            "NetworkSettings": {
                "Networks": {
                    f"{MONITOR_HOST.NOMBRE_RED_PHP}{self.id_proyecto.replace('-', '')[:12]}": {
                        "IPAddress": "172.19.0.2",
                    },
                },
            },
        })

    def inspeccion_red_php(self):
        return json.dumps({
            "Internal": True,
            "Labels": {"com.swatt.project-id": self.id_proyecto},
        })

    def test_valida_runtime_app_detenido_sin_ip_sin_relajar_sus_etiquetas(self):
        sufijo = self.id_proyecto.replace("-", "")[:12]
        red = f"{MONITOR_HOST.NOMBRE_RED_APP}{sufijo}"
        proyecto = {
            "id": self.id_proyecto,
            "runtimePerfil": "html",
            "runtime": MONITOR_HOST.PERFILES_RUNTIME["html"]["imagen"],
            "contenedor": f"swatt-app-{sufijo}",
            "puertoLocal": MONITOR_HOST.PUERTO_PHP_INICIAL + 2,
            "puertoInterno": MONITOR_HOST.PERFILES_RUNTIME["html"]["puerto"],
        }
        inspeccion = {
            "State": {"Running": False},
            "Config": {
                "Image": proyecto["runtime"],
                "Labels": {
                    "com.swatt.managed": "application",
                    "com.swatt.project-id": self.id_proyecto,
                    "com.swatt.runtime": "html",
                },
            },
            "NetworkSettings": {"Networks": {red: {"IPAddress": ""}}},
        }

        def ejecutar_falso(argumentos):
            if argumentos[0:2] == ["docker", "inspect"]:
                return json.dumps(inspeccion)
            if argumentos[0:3] == ["docker", "network", "inspect"]:
                return json.dumps({
                    "Internal": True,
                    "Labels": {"com.swatt.project-id": self.id_proyecto},
                })
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        with patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso):
            runtime, error = MONITOR_HOST.validar_runtime_app(proyecto)

        self.assertIsNone(error)
        self.assertEqual(runtime["ip"], "")
        inspeccion["Config"]["Labels"]["com.swatt.project-id"] = "otro-proyecto"
        with patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso):
            runtime, error = MONITOR_HOST.validar_runtime_app(proyecto)
        self.assertIsNone(runtime)
        self.assertIsNotNone(error)

    def test_valida_runtime_php_detenido_sin_ip(self):
        inspeccion = json.loads(self.inspeccion_php(False))
        identificador_red = f"{MONITOR_HOST.NOMBRE_RED_PHP}{self.id_proyecto.replace('-', '')[:12]}"
        inspeccion["NetworkSettings"]["Networks"][identificador_red]["IPAddress"] = ""

        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return json.dumps(inspeccion)
            if argumentos[:3] == ["docker", "network", "inspect"]:
                return self.inspeccion_red_php()
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        self.convertir_en_runtime("detenido")
        with patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso):
            runtime, error = MONITOR_HOST.validar_runtime_php(
                json.loads(self.ruta_registro.read_text(encoding="utf-8"))[0]
            )

        self.assertIsNone(error)
        self.assertEqual(runtime["ip"], "")

    def test_prepara_recreacion_de_runtime_php_que_no_monta_secreto(self):
        self.convertir_en_runtime()
        proyecto = json.loads(self.ruta_registro.read_text(encoding="utf-8"))[0]
        runtime = {"contenedor": proyecto["contenedor"], "datos": {"Mounts": []}}
        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "validar_runtime_php", return_value=(runtime, None)),
            patch.object(MONITOR_HOST, "runtime_monta_secreto_conexion", return_value=False),
            patch.object(MONITOR_HOST, "ejecutar", return_value="contenedor-retirado") as ejecutar,
            patch.object(MONITOR_HOST, "detener_proxy_php") as detener_proxy,
        ):
            resultado = MONITOR_HOST.preparar_actualizacion_proyecto({
                "accion": "preparar_actualizacion",
                "id": self.id_proyecto,
                "nombreConfirmado": self.nombre,
            })

        self.assertEqual(resultado, {
            "correcto": True,
            "nombre": self.nombre,
            "perfil": "php",
            "recrear": True,
        })
        ejecutar.assert_called_once_with(["docker", "rm", "--force", proyecto["contenedor"]])
        detener_proxy.assert_called_once_with(self.id_proyecto)
        actualizado = json.loads(self.ruta_registro.read_text(encoding="utf-8"))[0]
        self.assertEqual(actualizado["estado"], "pendiente_revision")
        self.assertNotIn("contenedor", actualizado)

    def test_detiene_solo_php_registrado_y_cierra_su_proxy(self):
        self.convertir_en_runtime()

        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return self.inspeccion_php(True)
            if argumentos[:3] == ["docker", "network", "inspect"]:
                return self.inspeccion_red_php() if argumentos[4] == "{{json .}}" else self.id_proyecto
            if argumentos[:3] == ["docker", "stop", "--time"]:
                return "detenido"
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
            patch.object(MONITOR_HOST, "detener_proxy_php") as detener_proxy,
        ):
            resultado = MONITOR_HOST.operar_runtime_php({
                "accion": "php_detener",
                "id": self.id_proyecto,
                "nombreConfirmado": self.nombre,
            })

        self.assertTrue(resultado["correcto"])
        self.assertEqual(resultado["estado"], "detenido")
        detener_proxy.assert_called_once_with(self.id_proyecto)
        actualizados = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        self.assertEqual(actualizados[0]["estadoRuntime"], "detenido")

    def test_inicia_runtime_y_recrea_proxy_local(self):
        self.convertir_en_runtime("detenido")
        inspecciones = iter([self.inspeccion_php(False), self.inspeccion_php(True)])

        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return next(inspecciones)
            if argumentos[:2] == ["docker", "network"]:
                return self.inspeccion_red_php()
            if argumentos[:2] == ["docker", "start"]:
                return "iniciado"
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
            patch.object(MONITOR_HOST, "detener_proxy_php") as detener_proxy,
            patch.object(MONITOR_HOST, "iniciar_proxy_php") as iniciar_proxy,
        ):
            resultado = MONITOR_HOST.operar_runtime_php({
                "accion": "php_iniciar",
                "id": self.id_proyecto,
                "nombreConfirmado": self.nombre,
            })

        self.assertTrue(resultado["correcto"])
        self.assertEqual(resultado["estado"], "activo")
        detener_proxy.assert_called_once_with(self.id_proyecto)
        iniciar_proxy.assert_called_once_with(
            self.id_proyecto,
            MONITOR_HOST.PUERTO_PHP_INICIAL + 2,
            "172.19.0.2",
        )
        actualizados = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        self.assertEqual(actualizados[0]["estadoRuntime"], "activo")

    def test_sincroniza_estado_real_del_runtime_al_listar(self):
        self.convertir_en_runtime("activo")

        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return self.inspeccion_php(False)
            if argumentos[:2] == ["docker", "network"]:
                return self.inspeccion_red_php()
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
            patch.object(MONITOR_HOST, "detener_proxy_php") as detener_proxy,
        ):
            resultado = MONITOR_HOST.consultar_estado_php()

        self.assertTrue(resultado["correcto"])
        self.assertEqual(resultado["proyectos"][0]["estado"], "detenido")
        detener_proxy.assert_any_call(self.id_proyecto)
        actualizados = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        self.assertEqual(actualizados[0]["estadoRuntime"], "detenido")

    def test_reinicia_runtime_activo_y_recrea_su_proxy(self):
        self.convertir_en_runtime("activo")
        inspecciones = iter([self.inspeccion_php(True), self.inspeccion_php(True)])

        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return next(inspecciones)
            if argumentos[:3] == ["docker", "network", "inspect"]:
                return self.inspeccion_red_php()
            if argumentos[:2] == ["docker", "restart"]:
                return "reiniciado"
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
            patch.object(MONITOR_HOST, "detener_proxy_php") as detener_proxy,
            patch.object(MONITOR_HOST, "iniciar_proxy_php") as iniciar_proxy,
        ):
            resultado = MONITOR_HOST.operar_runtime_php({
                "accion": "php_reiniciar",
                "id": self.id_proyecto,
                "nombreConfirmado": self.nombre,
            })

        self.assertTrue(resultado["correcto"])
        self.assertEqual(resultado["estado"], "activo")
        detener_proxy.assert_called_once_with(self.id_proyecto)
        iniciar_proxy.assert_called_once_with(
            self.id_proyecto,
            MONITOR_HOST.PUERTO_PHP_INICIAL + 2,
            "172.19.0.2",
        )

    def test_rechaza_puerto_inventariado_fuera_del_rango_reservado(self):
        self.convertir_en_runtime()
        registro = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        registro[0]["puertoLocal"] = 443
        self.ruta_registro.write_text(json.dumps(registro), encoding="utf-8")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "ejecutar") as ejecutar,
        ):
            resultado = MONITOR_HOST.operar_runtime_php({
                "accion": "php_detener",
                "id": self.id_proyecto,
                "nombreConfirmado": self.nombre,
            })

        self.assertFalse(resultado["correcto"])
        ejecutar.assert_not_called()

    def test_crea_postgresql_privado_con_volumen_y_secreto_no_publicado(self):
        self.convertir_en_runtime()
        creado = {"volumen": False, "marca": None}

        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return self.inspeccion_php(True)
            if argumentos[:3] == ["docker", "network", "inspect"]:
                return self.inspeccion_red_php() if argumentos[4] == "{{json .}}" else self.id_proyecto
            if argumentos[:4] == ["docker", "inspect", "--format", "{{.Id}}"]:
                return None
            if argumentos[:4] == ["docker", "image", "inspect", "--format"]:
                return "sha256:postgres-test"
            if argumentos[:3] == ["docker", "volume", "inspect"]:
                if not creado["volumen"]:
                    return None
                if argumentos[4] == "{{json .}}":
                    return json.dumps({"Labels": {
                        "com.swatt.managed": "database",
                        "com.swatt.project-id": self.id_proyecto,
                        "com.swatt.database.engine": "postgresql",
                        "com.swatt.creation-id": creado["marca"],
                    }, "Mountpoint": f"/var/lib/docker/volumes/swatt-dbdata-{self.id_proyecto.replace('-', '')[:12]}/_data"})
                return self.id_proyecto if "project-id" in argumentos[4] else "postgresql"
            if argumentos[:4] == ["docker", "inspect", "--format", "{{.State.Running}}"]:
                return "true"
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        def ejecutar_subproceso(argumentos, **opciones):
            if argumentos[:3] == ["docker", "volume", "create"]:
                creado["volumen"] = True
                creado["marca"] = next(
                    etiqueta.split("=", 1)[1]
                    for etiqueta in argumentos
                    if etiqueta.startswith("com.swatt.creation-id=")
                )
                return subprocess.CompletedProcess(argumentos, 0, "swatt-dbdata", "")
            if argumentos[:3] == ["docker", "run", "--detach"]:
                self.assertNotIn("--publish", argumentos)
                self.assertIn("--network-alias", argumentos)
                self.assertIn("base-datos", argumentos)
                self.assertIn("--memory", argumentos)
                self.assertIn("POSTGRES_PASSWORD_FILE=/run/secrets/swatt_db_root_password", argumentos)
                self.assertNotIn("POSTGRES_PASSWORD=", " ".join(argumentos))
                return subprocess.CompletedProcess(argumentos, 0, "b" * 64, "")
            self.fail(f"Subproceso Docker inesperado: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(
                MONITOR_HOST,
                "DIRECTORIO_SECRETOS",
                pathlib.Path(self.directorio_temporal.name) / "secretos",
            ),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
            patch.object(MONITOR_HOST.subprocess, "run", side_effect=ejecutar_subproceso),
        ):
            resultado = MONITOR_HOST.ejecutar_creacion_base_datos({
                "accion": "crear_base_datos",
                "id": self.id_proyecto,
                "motor": "postgresql",
                "nombreConfirmado": self.nombre,
                "nombreBaseDatos": "proyecto_web",
            })

        self.assertTrue(resultado["correcto"], resultado)
        self.assertEqual((resultado["host"], resultado["puerto"]), ("base-datos", 5432))
        self.assertEqual(resultado["usuario"], "swatt")
        self.assertRegex(resultado["contrasena"], r"^[a-f0-9]{64}$")
        registro = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        base_datos = registro[0]["baseDatos"]
        self.assertEqual(base_datos["motor"], "postgresql")
        self.assertEqual(base_datos["nombre"], "proyecto_web")
        self.assertTrue(resultado["rutaDatos"].endswith("/_data"))
        self.assertEqual(base_datos["volumen"], f"swatt-dbdata-{self.id_proyecto.replace('-', '')[:12]}")
        self.assertNotIn(resultado["contrasena"], json.dumps(registro))
        ruta_secreto = pathlib.Path(self.directorio_temporal.name) / "secretos" / self.id_proyecto / "clave"
        self.assertEqual(ruta_secreto.read_text(encoding="utf-8").strip(), resultado["contrasena"])
        ruta_sql = ruta_secreto.parent / "10-swatt-user.sql"
        self.assertIn("CREATE ROLE swatt LOGIN", ruta_sql.read_text(encoding="utf-8"))
        if os.name == "posix":
            self.assertEqual(ruta_secreto.stat().st_mode & 0o777, 0o444)

    def test_rechaza_motor_de_base_de_datos_arbitrario(self):
        with patch.object(MONITOR_HOST, "subprocess") as subproceso:
            resultado = MONITOR_HOST.ejecutar_creacion_base_datos({
                "accion": "crear_base_datos",
                "id": self.id_proyecto,
                "motor": "docker-compose",
                "nombreConfirmado": self.nombre,
            })

        self.assertFalse(resultado["correcto"])
        self.assertEqual(resultado["mensaje"], "motor de base de datos no permitido")
        subproceso.run.assert_not_called()

    def test_no_asocia_una_base_a_un_runtime_que_no_monta_el_secreto(self):
        self.convertir_en_runtime()
        runtime = {"datos": {"State": {"Running": True}}}
        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "validar_runtime_php", return_value=(runtime, None)),
            patch.object(MONITOR_HOST, "runtime_monta_secreto_conexion", return_value=False),
            patch.object(MONITOR_HOST.subprocess, "run") as ejecutar_subproceso,
        ):
            resultado = MONITOR_HOST.ejecutar_creacion_base_datos({
                "accion": "crear_base_datos",
                "id": self.id_proyecto,
                "motor": "postgresql",
                "nombreConfirmado": self.nombre,
            })

        self.assertFalse(resultado["correcto"])
        self.assertIn("debe recrearse", resultado["mensaje"])
        ejecutar_subproceso.assert_not_called()

    def test_crea_redis_con_configuracion_privada_y_persistencia(self):
        self.convertir_en_runtime()
        creado = {"volumen": False, "marca": None}

        def ejecutar_falso(argumentos):
            if argumentos[:4] == ["docker", "inspect", "--format", "{{json .}}"]:
                return self.inspeccion_php(True)
            if argumentos[:3] == ["docker", "network", "inspect"]:
                return self.inspeccion_red_php() if argumentos[4] == "{{json .}}" else self.id_proyecto
            if argumentos[:4] == ["docker", "inspect", "--format", "{{.Id}}"]:
                return None
            if argumentos[:4] == ["docker", "image", "inspect", "--format"]:
                return "sha256:redis-test"
            if argumentos[:3] == ["docker", "volume", "inspect"]:
                if not creado["volumen"]:
                    return None
                if argumentos[4] == "{{json .}}":
                    return json.dumps({"Labels": {
                        "com.swatt.managed": "database",
                        "com.swatt.project-id": self.id_proyecto,
                        "com.swatt.database.engine": "redis",
                        "com.swatt.creation-id": creado["marca"],
                    }, "Mountpoint": f"/var/lib/docker/volumes/swatt-dbdata-{self.id_proyecto.replace('-', '')[:12]}/_data"})
                return self.id_proyecto if "project-id" in argumentos[4] else "redis"
            if argumentos[:4] == ["docker", "inspect", "--format", "{{.State.Running}}"]:
                return "true"
            self.fail(f"Consulta Docker inesperada: {argumentos}")

        def ejecutar_subproceso(argumentos, **opciones):
            if argumentos[:3] == ["docker", "volume", "create"]:
                creado["volumen"] = True
                creado["marca"] = next(
                    etiqueta.split("=", 1)[1]
                    for etiqueta in argumentos
                    if etiqueta.startswith("com.swatt.creation-id=")
                )
                return subprocess.CompletedProcess(argumentos, 0, "swatt-dbdata", "")
            if argumentos[:3] == ["docker", "run", "--detach"]:
                self.assertNotIn("--publish", argumentos)
                self.assertNotIn("--env", argumentos)
                self.assertEqual(argumentos[-2:], ["redis-server", "/etc/redis/swatt.conf"])
                return subprocess.CompletedProcess(argumentos, 0, "c" * 64, "")
            self.fail(f"Subproceso Docker inesperado: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(
                MONITOR_HOST,
                "DIRECTORIO_SECRETOS",
                pathlib.Path(self.directorio_temporal.name) / "secretos",
            ),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
            patch.object(MONITOR_HOST.subprocess, "run", side_effect=ejecutar_subproceso),
        ):
            resultado = MONITOR_HOST.ejecutar_creacion_base_datos({
                "accion": "crear_base_datos",
                "id": self.id_proyecto,
                "motor": "redis",
                "nombreConfirmado": self.nombre,
            })

        self.assertTrue(resultado["correcto"], resultado)
        self.assertEqual((resultado["usuario"], resultado["puerto"]), ("swatt", 6379))
        ruta_configuracion = (
            pathlib.Path(self.directorio_temporal.name)
            / "secretos"
            / self.id_proyecto
            / "redis.conf"
        )
        configuracion = ruta_configuracion.read_text(encoding="utf-8")
        self.assertIn("appendonly yes", configuracion)
        self.assertIn("user default off", configuracion)
        self.assertIn(f"user swatt on >{resultado['contrasena']}", configuracion)

    def test_revela_credencial_con_identidad_docker_y_confirmacion_exactas(self):
        self.convertir_en_runtime()
        sufijo = self.id_proyecto.replace("-", "")[:12]
        registro = json.loads(self.ruta_registro.read_text(encoding="utf-8"))
        registro[0]["baseDatos"] = {
            "motor": "postgresql",
            "contenedor": f"swatt-db-{sufijo}",
            "volumen": f"swatt-dbdata-{sufijo}",
            "nombre": "swatt",
            "usuario": "swatt",
            "puerto": 5432,
        }
        self.ruta_registro.write_text(json.dumps(registro), encoding="utf-8")
        directorio_secretos = pathlib.Path(self.directorio_temporal.name) / "secretos"
        directorio_proyecto = directorio_secretos / self.id_proyecto
        directorio_proyecto.mkdir(parents=True)
        secreto = "d" * 64
        (directorio_proyecto / "clave").write_text(secreto, encoding="utf-8")
        inspeccion = json.dumps({
            "Config": {
                "Image": "postgres:17-alpine",
                "Labels": {
                    "com.swatt.managed": "database",
                    "com.swatt.project-id": self.id_proyecto,
                    "com.swatt.database.engine": "postgresql",
                },
            },
            "Mounts": [{
                "Type": "volume",
                "Name": f"swatt-dbdata-{sufijo}",
                "Destination": "/var/lib/postgresql/data",
            }],
        })

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.directorio_proyectos),
            patch.object(MONITOR_HOST, "DIRECTORIO_SECRETOS", directorio_secretos),
            patch.object(
                MONITOR_HOST,
                "ejecutar",
                side_effect=[
                    inspeccion,
                    self.id_proyecto,
                    "postgresql",
                    f"/var/lib/docker/volumes/swatt-dbdata-{sufijo}/_data",
                ],
            ) as ejecutar,
        ):
            rechazo = MONITOR_HOST.consultar_credenciales_base_datos({
                "accion": "credenciales_base_datos",
                "id": self.id_proyecto,
                "motor": "postgresql",
                "nombreConfirmado": "Nombre equivocado",
            })
            self.assertFalse(rechazo["correcto"])
            ejecutar.assert_not_called()

            resultado = MONITOR_HOST.consultar_credenciales_base_datos({
                "accion": "credenciales_base_datos",
                "id": self.id_proyecto,
                "motor": "postgresql",
                "nombreConfirmado": self.nombre,
            })

        self.assertTrue(resultado["correcto"], resultado)
        self.assertEqual(resultado["contrasena"], secreto)
        self.assertEqual(ejecutar.call_count, 4)

    def test_proxy_escucha_en_loopback_y_reenvia_al_backend_interno(self):
        puerto = MONITOR_HOST.PUERTO_PHP_INICIAL
        while True:
            with socket.socket() as prueba:
                try:
                    prueba.bind(("127.0.0.1", puerto))
                    break
                except OSError:
                    puerto += 1
                    if puerto > MONITOR_HOST.PUERTO_PHP_FINAL:
                        self.fail("No hay puertos libres para probar el proxy.")

        cuerpo_respuesta = b"respuesta PHP interna"

        class RespuestaFalsa:
            status = 200
            reason = "OK"
            length = len(cuerpo_respuesta)

            @staticmethod
            def getheaders():
                return [("Content-Type", "text/plain"), ("Content-Length", str(len(cuerpo_respuesta)))]

            @staticmethod
            def getheader(_nombre, _predeterminado=None):
                return None

            @staticmethod
            def read(_cantidad):
                nonlocal cuerpo_respuesta
                resultado = cuerpo_respuesta
                cuerpo_respuesta = b""
                return resultado

        class ConexionFalsa:
            def __init__(self, host, puerto_destino, timeout):
                self.host = host
                self.puerto = puerto_destino
                self.timeout = timeout
                self.solicitud = None

            def request(self, metodo, ruta, body=None, headers=None):
                self.solicitud = (metodo, ruta, body, headers)

            @staticmethod
            def getresponse():
                return RespuestaFalsa()

            @staticmethod
            def close():
                return None

        servidor = MONITOR_HOST.crear_servidor_proxy_php(puerto, "172.19.0.2")
        hilo = threading.Thread(target=servidor.serve_forever, daemon=True)
        conexiones = []

        def crear_conexion(*argumentos, **opciones):
            conexion = ConexionFalsa(*argumentos, **opciones)
            conexiones.append(conexion)
            return conexion

        self.addCleanup(servidor.server_close)
        self.addCleanup(servidor.shutdown)
        hilo.start()
        with patch.object(MONITOR_HOST.http.client, "HTTPConnection", side_effect=crear_conexion):
            with socket.create_connection(("127.0.0.1", puerto), timeout=2) as cliente:
                cliente.sendall(b"GET /prueba HTTP/1.1\r\nHost: ejemplo.invalid\r\nConnection: close\r\n\r\n")
                partes = []
                while True:
                    fragmento = cliente.recv(4096)
                    if not fragmento:
                        break
                    partes.append(fragmento)
                respuesta = b"".join(partes)

        self.assertEqual(servidor.server_address, ("127.0.0.1", puerto))
        self.assertIn(b"200 OK", respuesta)
        self.assertIn(b"respuesta PHP interna", respuesta)
        self.assertEqual(conexiones[0].host, "172.19.0.2")
        self.assertEqual(conexiones[0].puerto, 80)
        self.assertEqual(conexiones[0].solicitud[1], "/prueba")


class PruebasEliminacionProyecto(unittest.TestCase):
    """Comprueba que archivar retire solo recursos identificados como propios."""

    def setUp(self):
        self.temporal = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporal.cleanup)
        self.raiz = pathlib.Path(self.temporal.name)
        self.identificador = str(uuid.uuid4())
        self.nombre = "Proyecto archivado"
        self.sufijo = self.identificador.replace("-", "")[:12]
        self.registro = self.raiz / ".registro-swatt.json"
        self.registro.write_text(json.dumps([{
            "id": self.identificador,
            "nombre": self.nombre,
            "repositorio": "https://github.com/ejemplo/proyecto.git",
            "rama": "main",
            "commit": "0123456789ab",
            "archivosCompose": [],
            "estado": "pendiente_revision",
            "creado": "2026-09-30T00:00:00.000Z",
        }]), encoding="utf-8")

    def test_archiva_runtime_y_actualiza_registro(self):
        registro = json.loads(self.registro.read_text(encoding="utf-8"))
        registro[0].update({
            "estado": "desplegado",
            "runtime": MONITOR_HOST.IMAGEN_PHP_APACHE,
            "puertoLocal": MONITOR_HOST.PUERTO_PHP_INICIAL,
            "contenedor": f"swatt-php-{self.sufijo}",
        })
        self.registro.write_text(json.dumps(registro), encoding="utf-8")
        runtime = {
            "contenedor": f"swatt-php-{self.sufijo}",
            "red": f"{MONITOR_HOST.NOMBRE_RED_PHP}{self.sufijo}",
        }
        llamadas = []

        def ejecutar_falso(argumentos):
            llamadas.append(argumentos)
            if argumentos[:3] == ["docker", "rm", "--force"]:
                return "retirado"
            if argumentos[:3] == ["docker", "network", "inspect"]:
                return json.dumps({
                    "Internal": True,
                    "Labels": {
                        "com.swatt.project-id": self.identificador,
                        "com.swatt.managed": "php-project",
                    },
                })
            if argumentos[:3] == ["docker", "network", "rm"]:
                return runtime["red"]
            self.fail(f"Comando inesperado: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.raiz),
            patch.object(MONITOR_HOST, "validar_runtime_php", return_value=(runtime, None)),
            patch.object(MONITOR_HOST, "detener_proxy_php") as detener_proxy,
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
        ):
            resultado = MONITOR_HOST.archivar_proyecto({
                "id": self.identificador,
                "nombreConfirmado": self.nombre,
            })

        self.assertEqual(resultado, {
            "correcto": True,
            "nombre": self.nombre,
            "baseDatosConservada": False,
        })
        detener_proxy.assert_called_once_with(self.identificador)
        registro_final = json.loads(self.registro.read_text(encoding="utf-8"))[0]
        self.assertEqual(registro_final["estado"], "archivado")
        self.assertNotIn("runtime", registro_final)
        self.assertTrue(any(argumentos[:3] == ["docker", "rm", "--force"] for argumentos in llamadas))

    def test_elimina_solo_el_servicio_y_volumen_con_etiquetas_correctas(self):
        base_datos = {
            "motor": "postgresql",
            "contenedor": f"swatt-db-{self.sufijo}",
            "volumen": f"swatt-dbdata-{self.sufijo}",
            "nombre": "swatt",
            "usuario": "swatt",
            "puerto": 5432,
        }
        registro = json.loads(self.registro.read_text(encoding="utf-8"))
        registro[0].update({"estado": "archivado", "baseDatos": base_datos})
        self.registro.write_text(json.dumps(registro), encoding="utf-8")
        secretos = self.raiz / "secretos"
        (secretos / self.identificador).mkdir(parents=True)
        (secretos / self.identificador / "clave").write_text("secreto", encoding="utf-8")
        imagen = MONITOR_HOST.MOTORES_BASES_DATOS["postgresql"]["imagen"]
        volumen = base_datos["volumen"]
        contenedor = base_datos["contenedor"]
        llamadas = []

        def ejecutar_falso(argumentos):
            llamadas.append(argumentos)
            if argumentos[:3] == ["docker", "volume", "inspect"]:
                return json.dumps({
                    "Name": volumen,
                    "Labels": {
                        "com.swatt.managed": "database",
                        "com.swatt.project-id": self.identificador,
                        "com.swatt.database.engine": "postgresql",
                    },
                })
            if argumentos[:3] == ["docker", "inspect", "--format"]:
                return json.dumps({
                    "Name": f"/{contenedor}",
                    "Config": {
                        "Image": imagen,
                        "Labels": {
                            "com.swatt.managed": "database",
                            "com.swatt.project-id": self.identificador,
                            "com.swatt.database.engine": "postgresql",
                        },
                    },
                    "Mounts": [{
                        "Type": "volume",
                        "Name": volumen,
                        "Destination": MONITOR_HOST.MOTORES_BASES_DATOS["postgresql"]["ruta_datos"],
                    }],
                })
            if argumentos[:3] == ["docker", "rm", "--force"]:
                return "retirado"
            if argumentos[:3] == ["docker", "volume", "rm"]:
                return volumen
            if argumentos[:3] == ["docker", "network", "inspect"]:
                return None
            self.fail(f"Comando inesperado: {argumentos}")

        with (
            patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", self.raiz),
            patch.object(MONITOR_HOST, "DIRECTORIO_SECRETOS", secretos),
            patch.object(MONITOR_HOST, "ejecutar", side_effect=ejecutar_falso),
        ):
            resultado = MONITOR_HOST.eliminar_base_datos_archivada({
                "id": self.identificador,
                "motor": "postgresql",
                "nombreConfirmado": self.nombre,
            })

        self.assertEqual(resultado, {"correcto": True, "nombre": self.nombre})
        self.assertFalse((secretos / self.identificador).exists())
        self.assertTrue(any(argumentos[:3] == ["docker", "volume", "rm"] for argumentos in llamadas))
        self.assertEqual(json.loads(self.registro.read_text(encoding="utf-8"))[0]["estado"], "archivado")


class PruebasPerfilesRuntime(unittest.TestCase):
    """Comprueba que la interfaz del agente solo acepte perfiles conocidos."""

    def test_perfiles_php_y_html_aceptan_un_punto_de_entrada_anidado_unico(self):
        with tempfile.TemporaryDirectory() as directorio:
            raiz = pathlib.Path(directorio)
            (raiz / "Login" / "HTML").mkdir(parents=True)
            (raiz / "Login" / "HTML" / "index.php").write_text("<?php", encoding="utf-8")

            perfil_estatico, error_estatico = MONITOR_HOST.cargar_perfil_proyecto(raiz, "html")
            perfil, error = MONITOR_HOST.cargar_perfil_proyecto(raiz, "php")

        self.assertIsNone(perfil_estatico)
        self.assertIn("selecciona el perfil PHP", error_estatico)
        self.assertIsNone(error)
        self.assertEqual(perfil["rutaInicio"], "Login/HTML/index.php")

    def test_perfil_estatico_acepta_entrada_anidada_unica_y_prioriza_la_raiz(self):
        with tempfile.TemporaryDirectory() as directorio:
            raiz = pathlib.Path(directorio)
            (raiz / "sitio").mkdir()
            (raiz / "sitio" / "index.html").write_text("sitio", encoding="utf-8")
            perfil, error = MONITOR_HOST.cargar_perfil_proyecto(raiz, "html")
            self.assertIsNone(error)
            self.assertEqual(perfil["rutaInicio"], "sitio/index.html")

            (raiz / "index.html").write_text("raiz", encoding="utf-8")
            perfil_raiz, error_raiz = MONITOR_HOST.cargar_perfil_proyecto(raiz, "html")
            self.assertIsNone(error_raiz)
            self.assertEqual(perfil_raiz["rutaInicio"], "index.html")
            (raiz / "index.html").unlink()

            (raiz / "otra").mkdir()
            (raiz / "otra" / "index.html").write_text("otro", encoding="utf-8")
            ambiguo, error = MONITOR_HOST.cargar_perfil_proyecto(raiz, "html")

        self.assertIsNone(ambiguo)
        self.assertIn("exactamente un index.html", error)

    def test_valida_perfiles_soportados_y_rechaza_comandos_arbitrarios(self):
        identificador = str(uuid.uuid4())
        solicitud = {
            "accion": "desplegar_app",
            "id": identificador,
            "nombreConfirmado": "Proyecto",
            "perfil": "node",
        }
        self.assertEqual(
            MONITOR_HOST.validar_solicitud_despliegue_app(solicitud),
            ((identificador, "Proyecto", "node"), None),
        )
        solicitud["perfil"] = "docker-compose"
        self.assertEqual(
            MONITOR_HOST.validar_solicitud_despliegue_app(solicitud),
            (None, "perfil de runtime no permitido"),
        )

    def test_encamina_la_accion_de_despliegue_a_la_lista_allowlisted(self):
        solicitud = {
            "accion": "desplegar_app",
            "id": str(uuid.uuid4()),
            "nombreConfirmado": "Proyecto",
            "perfil": "html",
        }
        respuesta = {"correcto": True, "nombre": "Proyecto", "puerto": 18080}
        with patch.object(MONITOR_HOST, "ejecutar_despliegue_app", return_value=respuesta) as desplegar:
            self.assertIs(MONITOR_HOST.ejecutar_solicitud_accion(solicitud), respuesta)
        desplegar.assert_called_once_with(solicitud)

    def test_configuracion_nginx_estatica_usa_tmp_y_preserva_rutas_por_perfil(self):
        with tempfile.TemporaryDirectory() as directorio:
            raiz = pathlib.Path(directorio)
            for es_react, ruta_no_encontrada in ((False, "=404"), (True, "/index.html")):
                with self.subTest(es_react=es_react):
                    destino = raiz / ("react" if es_react else "html")
                    MONITOR_HOST.crear_configuracion_nginx_estatica(destino, es_react)
                    configuracion = (destino / "swatt.conf").read_text(encoding="utf-8")

                    for modulo in ("client", "proxy", "fastcgi", "uwsgi", "scgi"):
                        self.assertIn(f"_temp_path /tmp/{modulo}_temp;", configuracion)
                    self.assertIn(
                        f"try_files $uri $uri/ {ruta_no_encontrada};",
                        configuracion,
                    )

        self.assertEqual(
            MONITOR_HOST.COMANDO_NGINX_ESTATICO,
            ("nginx", "-g", "daemon off;"),
        )
        montajes_temporales = MONITOR_HOST.OPCIONES_TMPFS_RUNTIME[1::2]
        self.assertEqual(len(montajes_temporales), 3)
        for ruta in ("/tmp:", "/run:", "/var/cache/nginx:"):
            montaje = next(item for item in montajes_temporales if item.startswith(ruta))
            self.assertIn("uid=10001,gid=10001,mode=0755", montaje)


class PruebasTerminalInteractiva(unittest.TestCase):
    """Valida límites de rutas y dimensiones de la sesión Bash interactiva."""

    def test_rechaza_rutas_externas_y_dimensiones_invalidas(self):
        identificador = str(uuid.uuid4())
        solicitud = {
            "accion": "terminal_proyecto",
            "id": identificador,
            "nombreConfirmado": "Proyecto",
            "directorio": "src/../",
            "columnas": 120,
            "filas": 32,
        }
        self.assertEqual(
            MONITOR_HOST.validar_solicitud_terminal(solicitud),
            ((identificador, "Proyecto", ".", 120, 32), None),
        )
        solicitud["directorio"] = "../../etc"
        self.assertIn("permanecer dentro", MONITOR_HOST.validar_solicitud_terminal(solicitud)[1])
        solicitud["directorio"] = "/etc"
        self.assertIn("permanecer dentro", MONITOR_HOST.validar_solicitud_terminal(solicitud)[1])
        solicitud["directorio"] = "."
        solicitud["columnas"] = 500
        self.assertIn("ancho", MONITOR_HOST.validar_solicitud_terminal(solicitud)[1])
        solicitud["columnas"] = 100
        solicitud["filas"] = True
        self.assertIn("alto", MONITOR_HOST.validar_solicitud_terminal(solicitud)[1])

    def test_construye_solo_la_imagen_de_herramientas_fija(self):
        resultado_falso = subprocess.CompletedProcess(
            ["docker", "build"], 0, "", "",
        )
        contexto_build = {}

        def construir_falso(argumentos, **_opciones):
            contexto_build["dockerfile"] = (
                pathlib.Path(argumentos[-1]) / "Dockerfile"
            ).read_text(encoding="utf-8")
            return resultado_falso

        with (
            patch.object(MONITOR_HOST, "ejecutar", return_value=None),
            patch.object(MONITOR_HOST.subprocess, "run", side_effect=construir_falso) as construir,
        ):
            correcto, error = MONITOR_HOST.asegurar_imagen_terminal()
        self.assertTrue(correcto)
        self.assertIsNone(error)
        argumentos = construir.call_args.args[0]
        self.assertEqual(argumentos[:3], ["docker", "build", "--pull"])
        self.assertEqual(argumentos[argumentos.index("--tag") + 1], MONITOR_HOST.IMAGEN_TERMINAL)
        contenido = contexto_build["dockerfile"]
        self.assertIn("git", contenido)
        self.assertIn("python3-venv", contenido)
        self.assertIn("node:22-bookworm-slim", contenido)
        self.assertNotIn("FROM ", contenido.replace("FROM node:22-bookworm-slim", ""))


class PruebasConsolaProyecto(unittest.TestCase):
    """Comprueba que la consola solo opere sobre una carpeta de proyecto."""

    def test_valida_comandos_y_rechaza_rutas_externas(self):
        identificador = str(uuid.uuid4())
        solicitud = {
            "accion": "consola_proyecto",
            "id": identificador,
            "nombreConfirmado": "Proyecto",
            "comando": "ls -la",
            "directorio": "src/../",
        }
        self.assertEqual(
            MONITOR_HOST.validar_solicitud_consola(solicitud),
            ((identificador, "Proyecto", "ls -la", "."), None),
        )
        solicitud["directorio"] = "../../etc"
        resultado, error = MONITOR_HOST.validar_solicitud_consola(solicitud)
        self.assertIsNone(resultado)
        self.assertIn("permanecer dentro", error)
        solicitud["directorio"] = "."
        solicitud["comando"] = "x" * 2049
        self.assertIsNotNone(MONITOR_HOST.validar_solicitud_consola(solicitud)[1])

    def test_ejecuta_solo_en_toolbox_sin_red_con_limites(self):
        identificador = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as temporal:
            proyectos = pathlib.Path(temporal)
            (proyectos / identificador).mkdir()
            (proyectos / ".registro-swatt.json").write_text(json.dumps([{
                "id": identificador,
                "nombre": "Proyecto",
                "estado": "pendiente_revision",
            }]), encoding="utf-8")
            salida_falsa = subprocess.CompletedProcess(
                ["docker"], 0, "archivo.txt\n", "",
            )
            with (
                patch.object(MONITOR_HOST, "DIRECTORIO_PROYECTOS", proyectos),
                patch.object(MONITOR_HOST.subprocess, "run", return_value=salida_falsa) as ejecutar,
            ):
                resultado = MONITOR_HOST.ejecutar_consola_proyecto({
                    "accion": "consola_proyecto",
                    "id": identificador,
                    "nombreConfirmado": "Proyecto",
                    "comando": "ls",
                    "directorio": ".",
                })
        self.assertTrue(resultado["correcto"], resultado)
        self.assertEqual(resultado["salida"], "archivo.txt\n")
        argumentos = ejecutar.call_args.args[0]
        self.assertIn("--network", argumentos)
        self.assertEqual(argumentos[argumentos.index("--network") + 1], "none")
        self.assertIn("--cap-drop", argumentos)
        self.assertIn("ALL", argumentos)
        self.assertIn("--read-only", argumentos)
        self.assertIn("192m", argumentos)


class PruebasAccesoTailscale(unittest.TestCase):
    """Verifica que el agente gestione solo los puertos privados que registra."""

    def test_habilita_y_retira_solo_el_forwarding_registrado(self):
        identificador = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as directorio:
            archivo = pathlib.Path(directorio) / "tailscale-servicios.json"
            respuestas = [
                subprocess.CompletedProcess([], 0, '{"TCP":{}}', ""),
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 0, "", ""),
            ]
            with (
                patch.object(MONITOR_HOST, "ARCHIVO_TAILSCALE", archivo),
                patch.object(MONITOR_HOST, "TAILSCALE_SERVE_HABILITADO", True),
                patch.object(MONITOR_HOST.subprocess, "run", side_effect=respuestas) as ejecutar,
            ):
                MONITOR_HOST.habilitar_acceso_tailscale(identificador, 18080)
                self.assertEqual(
                    json.loads(archivo.read_text(encoding="utf-8"))["proyectos"][identificador],
                    {"puerto": 18080},
                )
                MONITOR_HOST.deshabilitar_acceso_tailscale(identificador)

            self.assertEqual(ejecutar.call_args_list[1].args[0], [
                "tailscale", "serve", "--bg", "--tcp", "18080", "tcp://127.0.0.1:18080",
            ])
            self.assertEqual(ejecutar.call_args_list[2].args[0], [
                "tailscale", "serve", "--tcp", "18080", "off",
            ])
            self.assertEqual(json.loads(archivo.read_text(encoding="utf-8"))["proyectos"], {})

    def test_no_reemplaza_un_puerto_tailscale_ajeno(self):
        identificador = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as directorio:
            archivo = pathlib.Path(directorio) / "tailscale-servicios.json"
            respuesta = subprocess.CompletedProcess([], 0, '{"TCP":{"18080":{}}}', "")
            with (
                patch.object(MONITOR_HOST, "ARCHIVO_TAILSCALE", archivo),
                patch.object(MONITOR_HOST, "TAILSCALE_SERVE_HABILITADO", True),
                patch.object(MONITOR_HOST.subprocess, "run", return_value=respuesta) as ejecutar,
            ):
                with self.assertRaisesRegex(ValueError, "no pertenece a esta aplicación"):
                    MONITOR_HOST.habilitar_acceso_tailscale(identificador, 18080)

            ejecutar.assert_called_once()

    def test_fallo_de_permisos_tailscale_no_cierra_el_proxy_local(self):
        identificador = str(uuid.uuid4())
        servidor = unittest.mock.Mock()
        hilo = unittest.mock.Mock()
        hilo.is_alive.return_value = True
        try:
            with (
                patch.object(MONITOR_HOST, "TAILSCALE_SERVE_HABILITADO", True),
                patch.object(MONITOR_HOST, "crear_servidor_proxy_php", return_value=servidor),
                patch.object(MONITOR_HOST.threading, "Thread", return_value=hilo),
                patch.object(
                    MONITOR_HOST,
                    "habilitar_acceso_tailscale",
                    side_effect=ValueError("permiso denegado"),
                ),
            ):
                proxy = MONITOR_HOST.iniciar_proxy_php(
                    identificador,
                    18080,
                    "172.19.0.2",
                )

            self.assertIs(MONITOR_HOST.proxies_php[identificador], proxy)
            self.assertFalse(servidor.shutdown.called)
            self.assertFalse(servidor.server_close.called)
            hilo.start.assert_called_once()
        finally:
            MONITOR_HOST.proxies_php.pop(identificador, None)


if __name__ == "__main__":
    unittest.main()
