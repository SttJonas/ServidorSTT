#!/usr/bin/python3

import json
import http.client
import http.server
import ipaddress
import logging
import os
import pathlib
import posixpath
import re
import secrets
import select
import socketserver
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import traceback
import tomllib
import zipfile
from datetime import datetime, timezone


DIRECTORIO_ESTADO = pathlib.Path("/run/swatt-monitor")
ARCHIVO_ESTADO = DIRECTORIO_ESTADO / "estado.json"
ARCHIVO_SOCKET_ACCIONES = DIRECTORIO_ESTADO / "acciones.sock"
ARCHIVO_TAILSCALE = pathlib.Path("/var/lib/swatt-monitor/tailscale-servicios.json")
INTERVALO_SEGUNDOS = 5
ACCIONES_DOCKER_PERMITIDAS = {"iniciar": "start", "detener": "stop", "reiniciar": "restart"}
DIRECTORIO_PROYECTOS = pathlib.Path(
    os.environ.get("DIRECTORIO_PROYECTOS", "/srv/panel/proyectos")
)
IMAGEN_PHP_APACHE = "php:8.3-apache"
MOTORES_BASES_DATOS = {
    "postgresql": {
        "imagen": "postgres:17-alpine",
        "puerto": 5432,
        "variable_usuario": "POSTGRES_USER",
        "variable_base": "POSTGRES_DB",
        "variable_clave": "POSTGRES_PASSWORD_FILE",
        "ruta_datos": "/var/lib/postgresql/data",
        "nombre_base": "swatt",
        "nombre_usuario": "swatt_admin",
        "usuario_aplicacion": "swatt",
    },
    "mariadb": {
        "imagen": "mariadb:11.4",
        "puerto": 3306,
        "variable_usuario": "MARIADB_USER",
        "variable_base": "MARIADB_DATABASE",
        "variable_clave": "MARIADB_PASSWORD_FILE",
        "ruta_datos": "/var/lib/mysql",
        "nombre_base": "swatt",
        "nombre_usuario": "swatt",
        "usuario_aplicacion": "swatt",
    },
    "mongodb": {
        "imagen": "mongo:8.0",
        "puerto": 27017,
        "variable_usuario": "MONGO_INITDB_ROOT_USERNAME",
        "variable_base": "MONGO_INITDB_DATABASE",
        "variable_clave": "MONGO_INITDB_ROOT_PASSWORD_FILE",
        "ruta_datos": "/data/db",
        "nombre_base": "swatt",
        "nombre_usuario": "swatt_admin",
        "usuario_aplicacion": "swatt",
    },
    "redis": {
        "imagen": "redis:7-alpine",
        "puerto": 6379,
        "ruta_datos": "/data",
        "nombre_base": "0",
        "nombre_usuario": "swatt",
        "usuario_aplicacion": "swatt",
    },
}
DIRECTORIO_SECRETOS = pathlib.Path("/var/lib/swatt-monitor/secretos")
DIRECTORIO_RUNTIMES = pathlib.Path("/var/lib/swatt-monitor/runtimes")
PUERTO_PHP_INICIAL = 18080
PUERTO_PHP_FINAL = 18179
NOMBRE_RED_PHP = "swatt-php-"
NOMBRE_RED_APP = "swatt-app-"
MAXIMO_APLICACIONES_ADMINISTRADAS = 4
MAXIMO_BASES_DATOS_ADMINISTRADAS = 4
OPCIONES_TMPFS_RUNTIME = (
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m,uid=10001,gid=10001,mode=0755",
    "--tmpfs", "/run:rw,noexec,nosuid,size=8m,uid=10001,gid=10001,mode=0755",
    "--tmpfs", "/var/cache/nginx:rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=0755",
)
COMANDO_NGINX_ESTATICO = ("nginx", "-g", "daemon off;")
PERFILES_RUNTIME = {
    "html": {"imagen": "nginx:1.27-alpine", "puerto": 8080, "tipo": "estatico"},
    "php": {"imagen": IMAGEN_PHP_APACHE, "puerto": 80, "tipo": "php"},
    "node": {"imagen": "node:22-bookworm-slim", "puerto": 3000, "tipo": "node"},
    "react": {"imagen": "nginx:1.27-alpine", "puerto": 8080, "tipo": "react"},
    "python": {"imagen": "python:3.12-slim", "puerto": 8000, "tipo": "python"},
    "ruby": {"imagen": "ruby:3.3-slim", "puerto": 3000, "tipo": "ruby"},
    "java": {"imagen": "eclipse-temurin:21-jre", "puerto": 8080, "tipo": "java"},
    "kotlin": {"imagen": "eclipse-temurin:21-jre", "puerto": 8080, "tipo": "java"},
    "go": {"imagen": "gcr.io/distroless/base-debian12:nonroot", "puerto": 8080, "tipo": "binario"},
    "rust": {"imagen": "gcr.io/distroless/cc-debian12:nonroot", "puerto": 8080, "tipo": "binario"},
}
cerradura_acciones = threading.Lock()
sesiones_terminales = threading.BoundedSemaphore(4)
cerradura_imagen_terminal = threading.Lock()
IMAGEN_TERMINAL = "swatt-terminal:node22"
DOCKERFILE_TERMINAL = """FROM node:22-bookworm-slim
RUN apt-get update \\
    && apt-get install -y --no-install-recommends bash git ca-certificates curl python3 python3-pip python3-venv build-essential \\
    && rm -rf /var/lib/apt/lists/*
"""
proxies_php = {}
cerradura_proxies = threading.Lock()
cerradura_tailscale = threading.Lock()
TAILSCALE_SERVE_HABILITADO = os.environ.get("SWATT_TAILSCALE_SERVE", "").lower() == "true"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def ejecutar(argumentos):
    """Ejecuta una consulta fija, sin shell ni parámetros del navegador."""
    try:
        resultado = subprocess.run(
            argumentos,
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if resultado.returncode != 0:
        return None
    return resultado.stdout.strip()


def leer_cpu():
    """Lee los contadores acumulados de CPU expuestos por el kernel."""
    with open("/proc/stat", encoding="ascii") as archivo:
        valores = archivo.readline().split()[1:]
    contadores = [int(valor) for valor in valores]
    inactivo = contadores[3] + (contadores[4] if len(contadores) > 4 else 0)
    return sum(contadores), inactivo


def calcular_uso_cpu(anterior):
    """Calcula el porcentaje ocupado entre dos lecturas de /proc/stat."""
    actual = leer_cpu()
    if anterior is None:
        return actual, 0
    total_delta = actual[0] - anterior[0]
    inactivo_delta = actual[1] - anterior[1]
    if total_delta <= 0:
        return actual, 0
    porcentaje = round((1 - inactivo_delta / total_delta) * 100)
    return actual, max(0, min(100, porcentaje))


def leer_memoria():
    """Obtiene memoria total y disponible desde /proc/meminfo."""
    valores = {}
    with open("/proc/meminfo", encoding="ascii") as archivo:
        for linea in archivo:
            nombre, valor, *_ = linea.split()
            if nombre in ("MemTotal:", "MemAvailable:"):
                valores[nombre] = int(valor)
    total = valores["MemTotal:"]
    disponible = valores["MemAvailable:"]
    usada = total - disponible
    return {
        "totalMb": round(total / 1024),
        "usadaMb": round(usada / 1024),
        "libreMb": round(disponible / 1024),
        "porcentaje": round(usada / total * 100),
    }


def leer_disco():
    """Consulta el sistema de archivos raíz del host y su dispositivo."""
    espacio = os.statvfs("/")
    total_bytes = espacio.f_blocks * espacio.f_frsize
    libre_bytes = espacio.f_bavail * espacio.f_frsize
    usado_bytes = total_bytes - espacio.f_bfree * espacio.f_frsize
    resultado_df = ejecutar(["df", "-P", "/"])
    dispositivo = resultado_df.splitlines()[-1].split()[0] if resultado_df else "No disponible"
    gb = 1024**3
    return {
        "disponible": True,
        "dispositivo": dispositivo,
        "totalGb": round(total_bytes / gb, 1),
        "usadoGb": round(usado_bytes / gb, 1),
        "libreGb": round(libre_bytes / gb, 1),
        "porcentaje": round(usado_bytes / total_bytes * 100) if total_bytes else 0,
    }


def leer_red():
    """Identifica la interfaz predeterminada y sus direcciones IP."""
    rutas = ejecutar(["ip", "-j", "route", "show", "default"])
    rutas_predeterminadas = json.loads(rutas) if rutas else []
    if not rutas_predeterminadas:
        return {
            "disponible": False,
            "interfaz": None,
            "ipv4": None,
            "ipv6": None,
            "gateway": None,
            "dns": leer_dns(),
        }
    ruta_predeterminada = rutas_predeterminadas[0]
    interfaz = ruta_predeterminada.get("dev")
    gateway = ruta_predeterminada.get("gateway")
    if not interfaz:
        return {
            "disponible": False,
            "interfaz": None,
            "ipv4": None,
            "ipv6": None,
            "gateway": gateway,
            "dns": leer_dns(),
        }
    direcciones = ejecutar(["ip", "-j", "address", "show", "dev", interfaz])
    direcciones_interfaz = json.loads(direcciones) if direcciones else []
    if not direcciones_interfaz:
        return {
            "disponible": False,
            "interfaz": interfaz,
            "ipv4": None,
            "ipv6": None,
            "gateway": gateway,
            "dns": leer_dns(),
        }
    datos = direcciones_interfaz[0].get("addr_info", [])
    ipv4 = next((dato["local"] for dato in datos if dato.get("family") == "inet"), None)
    ipv6 = next((dato["local"] for dato in datos if dato.get("family") == "inet6"), None)
    return {
        "disponible": True,
        "interfaz": interfaz,
        "ipv4": ipv4,
        "ipv6": ipv6,
        "gateway": gateway,
        "dns": leer_dns(),
    }


def leer_dns():
    """Lee únicamente las direcciones de servidores DNS configuradas localmente."""
    try:
        with open("/etc/resolv.conf", encoding="utf-8") as archivo:
            servidores = [
                partes[1]
                for linea in archivo
                if (partes := linea.split())[:1] == ["nameserver"] and len(partes) > 1
            ]
        return servidores[:4]
    except OSError:
        return []


def leer_swap():
    """Consulta el total y espacio disponible de intercambio en Linux."""
    try:
        with open("/proc/meminfo", encoding="ascii") as archivo:
            valores = {}
            for linea in archivo:
                nombre, valor, *_ = linea.split()
                if nombre in ("SwapTotal:", "SwapFree:"):
                    valores[nombre] = int(valor)
        total = valores.get("SwapTotal:", 0)
        disponible = valores.get("SwapFree:", 0)
        return {
            "disponible": True,
            "totalMb": round(total / 1024),
            "libreMb": round(disponible / 1024),
            "usadaMb": round((total - disponible) / 1024),
        }
    except (OSError, ValueError):
        return {"disponible": False, "totalMb": None, "libreMb": None, "usadaMb": None}


def leer_mantenimiento():
    """Resume el tiempo activo y avisos de reinicio pendientes, sin cambiar el host."""
    try:
        with open("/proc/uptime", encoding="ascii") as archivo:
            tiempo_activo = int(float(archivo.readline().split()[0]))
    except (OSError, ValueError, IndexError):
        tiempo_activo = None
    return {
        "tiempoActivoSegundos": tiempo_activo,
        "reinicioNecesario": os.path.exists("/var/run/reboot-required"),
        "swap": leer_swap(),
    }


def normalizar_contenedores(salida):
    """Convierte JSON Lines de Docker en metadatos acotados para el panel."""
    contenedores = []
    for linea in salida.splitlines():
        dato = json.loads(linea)
        etiquetas = dato.get("Labels", "")
        es_panel = "com.docker.compose.service=panel" in etiquetas
        es_php_administrado = "com.swatt.managed=php-project" in etiquetas
        contenedores.append({
            "id": dato.get("ID", "")[:16],
            "nombre": dato.get("Names", "")[:128],
            "imagen": dato.get("Image", "")[:256],
            "estado": dato.get("Status", "")[:128],
            "puertos": dato.get("Ports", "")[:512],
            "creado": dato.get("CreatedAt", "")[:64],
            "ejecutando": dato.get("State", "").lower() == "running",
            "administrable": not es_panel and not es_php_administrado,
        })
    return contenedores


def obtener_contenedores_docker():
    """Consulta contenedores activos y detenidos sin aceptar filtros externos."""
    version = ejecutar(["docker", "info", "--format", "{{.ServerVersion}}"])
    salida = ejecutar(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"]) if version else None
    if version is None or salida is None:
        return None, version
    return normalizar_contenedores(salida), version


def leer_docker():
    """Consulta Docker y limita la lista visible a cien contenedores."""
    contenedores, version = obtener_contenedores_docker()
    if version is None or contenedores is None:
        return {
            "disponible": False,
            "version": None,
            "contenedoresActivos": 0,
            "contenedores": [],
            "contenedoresTotal": None,
            "error": "No se pudo consultar Docker desde el agente.",
        }

    activos = sum(1 for contenedor in contenedores if contenedor["ejecutando"])
    return {
        "disponible": True,
        "version": version,
        "contenedoresActivos": activos,
        "contenedores": contenedores[:100],
        "contenedoresTotal": len(contenedores),
        "listaLimitada": len(contenedores) > 100,
        "error": None,
    }


def validar_solicitud_accion(solicitud, contenedores):
    """Valida la allowlist de acciones, el ID y la confirmación del nombre."""
    if not isinstance(solicitud, dict):
        return None, "solicitud inválida"
    accion = solicitud.get("accion")
    identificador = solicitud.get("id")
    nombre_confirmado = solicitud.get("nombreConfirmado")
    if not isinstance(accion, str) or accion not in ACCIONES_DOCKER_PERMITIDAS:
        return None, "acción no permitida"
    if not isinstance(identificador, str) or not 12 <= len(identificador) <= 64:
        return None, "identificador inválido"
    if any(caracter not in "0123456789abcdef" for caracter in identificador.lower()):
        return None, "identificador inválido"

    coincidencias = [
        dato for dato in contenedores
        if dato.get("ID", "").lower().startswith(identificador.lower())
    ]
    if len(coincidencias) != 1:
        return None, "contenedor inexistente o identificador ambiguo"
    contenedor = coincidencias[0]
    if "com.docker.compose.service=panel" in contenedor.get("Labels", ""):
        return None, "el contenedor del panel está protegido"
    if "com.swatt.managed=php-project" in contenedor.get("Labels", ""):
        return None, "los proyectos PHP se administran desde Proyectos"
    nombre = contenedor.get("Names", "")
    if not nombre or nombre_confirmado != nombre:
        return None, "el nombre de confirmación no coincide"

    ejecutando = contenedor.get("State", "").lower() == "running"
    if accion == "iniciar" and ejecutando:
        return None, "el contenedor ya está iniciado"
    if accion in ("detener", "reiniciar") and not ejecutando:
        return None, "el contenedor no está iniciado"
    return (accion, contenedor.get("ID", ""), nombre), None


def ejecutar_accion_docker(solicitud):
    """Ejecuta una única operación Docker validada en el host."""
    version = ejecutar(["docker", "info", "--format", "{{.ServerVersion}}"])
    if version is None:
        return {"correcto": False, "mensaje": "Docker no está disponible."}

    salida_completa = ejecutar(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"])
    if salida_completa is None:
        return {"correcto": False, "mensaje": "No se pudo validar el estado de Docker."}
    try:
        registros = [json.loads(linea) for linea in salida_completa.splitlines()] if salida_completa else []
    except json.JSONDecodeError:
        return {"correcto": False, "mensaje": "No se pudo validar el estado de Docker."}

    accion_validada, error = validar_solicitud_accion(solicitud, registros)
    if error:
        return {"correcto": False, "mensaje": error}

    accion, identificador, nombre = accion_validada
    argumentos = ["docker", ACCIONES_DOCKER_PERMITIDAS[accion], identificador]
    try:
        resultado = subprocess.run(
            argumentos,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {"correcto": False, "mensaje": "La acción superó el tiempo límite."}
    if resultado.returncode != 0:
        logging.warning("Docker rechazó la acción %s para el contenedor %s.", accion, identificador[:12])
        return {"correcto": False, "mensaje": "Docker no pudo completar la acción."}
    logging.info("Acción Docker %s completada para el contenedor %s.", accion, identificador[:12])
    return {"correcto": True, "accion": accion, "nombre": nombre}


def validar_solicitud_despliegue(solicitud):
    """Valida una solicitud del único runtime PHP administrado por el panel."""
    if not isinstance(solicitud, dict) or solicitud.get("accion") != "desplegar_php":
        return None, "acción de despliegue no permitida"
    identificador = solicitud.get("id")
    nombre_confirmado = solicitud.get("nombreConfirmado")
    if not isinstance(identificador, str) or not re.fullmatch(r"[a-f0-9-]{36}", identificador, re.IGNORECASE):
        return None, "identificador de proyecto inválido"
    if not isinstance(nombre_confirmado, str) or not 2 <= len(nombre_confirmado) <= 60:
        return None, "nombre de confirmación inválido"
    return (identificador.lower(), nombre_confirmado), None


def validar_solicitud_operacion_php(solicitud):
    """Valida las únicas operaciones admitidas sobre runtimes PHP del registro."""
    if not isinstance(solicitud, dict):
        return None, "solicitud inválida"
    accion = solicitud.get("accion")
    identificador = solicitud.get("id")
    nombre_confirmado = solicitud.get("nombreConfirmado")
    if accion not in {"php_iniciar", "php_detener", "php_reiniciar"}:
        return None, "acción PHP no permitida"
    if not isinstance(identificador, str) or not re.fullmatch(r"[a-f0-9-]{36}", identificador, re.IGNORECASE):
        return None, "identificador de proyecto inválido"
    if not isinstance(nombre_confirmado, str) or not 2 <= len(nombre_confirmado) <= 60:
        return None, "nombre de confirmación inválido"
    return (accion, identificador.lower(), nombre_confirmado), None


def validar_solicitud_actualizacion(solicitud):
    """Valida que una actualización solo afecte al runtime del proyecto indicado."""
    if not isinstance(solicitud, dict) or solicitud.get("accion") != "preparar_actualizacion":
        return None, "acción de actualización no permitida"
    identificador = solicitud.get("id")
    nombre = solicitud.get("nombreConfirmado")
    if not isinstance(identificador, str) or not re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
        identificador,
        re.IGNORECASE,
    ):
        return None, "identificador de proyecto inválido"
    if not isinstance(nombre, str) or not 2 <= len(nombre) <= 60:
        return None, "nombre de confirmación inválido"
    return (identificador.lower(), nombre), None


def preparar_actualizacion_proyecto(solicitud):
    """Retira solo la aplicación actual y conserva su base y su volumen."""
    validada, error = validar_solicitud_actualizacion(solicitud)
    if error:
        return {"correcto": False, "mensaje": error}
    identificador, nombre_confirmado = validada
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el registro del proyecto."}
    if not isinstance(registro, list):
        return {"correcto": False, "mensaje": "El registro del proyecto no es válido."}
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ]
    if len(proyectos) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto."}
    proyecto = proyectos[0]
    if proyecto.get("nombre") != nombre_confirmado or proyecto.get("estado") != "desplegado":
        return {"correcto": False, "mensaje": "El proyecto no está desplegado o el nombre no coincide."}

    perfil = proyecto.get("runtimePerfil", "php")
    if perfil == "php":
        runtime, error_runtime = validar_runtime_php(proyecto)
        if error_runtime:
            return {"correcto": False, "mensaje": error_runtime}
        if not runtime_monta_secreto_conexion(runtime):
            detener_proxy_php(identificador)
            retirado = ejecutar(["docker", "rm", "--force", runtime["contenedor"]])
            if retirado is None:
                return {"correcto": False, "mensaje": "No se pudo retirar el runtime PHP antiguo para recrearlo."}
            for campo in (
                "runtime", "runtimePerfil", "puertoInterno", "puertoLocal",
                "contenedor", "idContenedor", "estadoRuntime", "rutaInicio",
            ):
                proyecto.pop(campo, None)
            proyecto["estado"] = "pendiente_revision"
            try:
                guardar_registro_proyectos(registro)
            except OSError:
                logging.exception("Se retiró el runtime PHP antiguo, pero no se pudo actualizar el registro %s.", identificador[:12])
                return {"correcto": False, "mensaje": "Se retiró el runtime antiguo, pero no se pudo guardar el estado para recrearlo."}
            return {
                "correcto": True,
                "nombre": nombre_confirmado,
                "perfil": "php",
                "recrear": True,
            }
        resultado = operar_runtime_php({
            "accion": "php_reiniciar",
            "id": identificador,
            "nombreConfirmado": nombre_confirmado,
        })
        if resultado.get("correcto") is True:
            resultado["perfil"] = "php"
        return resultado

    runtime, error = validar_runtime_app(proyecto)
    if error:
        return {"correcto": False, "mensaje": error}
    origen_runtime = next(
        (
            pathlib.Path(montaje.get("Source", ""))
            for montaje in runtime["datos"].get("Mounts", [])
            if isinstance(montaje, dict) and montaje.get("Destination") == "/app"
        ),
        None,
    )
    try:
        raiz_runtimes = DIRECTORIO_RUNTIMES.resolve(strict=True)
        if (
            origen_runtime is None
            or origen_runtime.is_symlink()
            or origen_runtime.resolve(strict=True).parent != raiz_runtimes
            or origen_runtime.resolve(strict=True).name != identificador
        ):
            return {"correcto": False, "mensaje": "No se validó la carpeta del runtime para actualizarlo."}
    except OSError:
        return {"correcto": False, "mensaje": "No se pudo validar la carpeta del runtime."}

    detener_proxy_php(identificador)
    resultado_retiro = ejecutar(["docker", "rm", "--force", runtime["contenedor"]])
    if resultado_retiro is None:
        return {"correcto": False, "mensaje": "No se pudo retirar el runtime anterior para actualizarlo."}
    shutil.rmtree(origen_runtime)

    if not proyecto.get("baseDatos"):
        nombre_red = runtime["red"]
        try:
            datos_red = ejecutar([
                "docker", "network", "inspect", "--format", "{{json .}}", nombre_red,
            ])
            red = json.loads(datos_red) if datos_red else {}
            if red.get("Labels", {}).get("com.swatt.project-id") != identificador:
                return {"correcto": False, "mensaje": "La red no coincide con el proyecto y se conservará."}
            resultado_red = ejecutar(["docker", "network", "rm", nombre_red])
            if resultado_red is None:
                return {"correcto": False, "mensaje": "No se pudo retirar la red vacía del runtime."}
        except (OSError, ValueError, json.JSONDecodeError):
            logging.exception("No se pudo retirar la red del proyecto %s.", identificador[:12])
            return {"correcto": False, "mensaje": "No se pudo preparar la red para la actualización."}

    campos_runtime = (
        "runtime", "runtimePerfil", "puertoInterno", "puertoLocal",
        "contenedor", "idContenedor", "estadoRuntime", "rutaInicio",
    )
    for campo in campos_runtime:
        proyecto.pop(campo, None)
    proyecto["estado"] = "pendiente_revision"
    try:
        guardar_registro_proyectos(registro)
    except OSError:
        logging.exception("No se pudo marcar como pendiente el proyecto %s para actualizarlo.", identificador[:12])
        return {"correcto": False, "mensaje": "El runtime se retiró, pero no se pudo guardar el estado de actualización."}
    return {"correcto": True, "nombre": nombre_confirmado, "perfil": perfil}


def archivar_proyecto(solicitud):
    """Retira el runtime y conserva la base administrada hasta borrarla por separado."""
    identificador = solicitud.get("id") if isinstance(solicitud, dict) else None
    nombre_confirmado = solicitud.get("nombreConfirmado") if isinstance(solicitud, dict) else None
    if (
        not isinstance(identificador, str)
        or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", identificador)
        or not isinstance(nombre_confirmado, str)
        or not 2 <= len(nombre_confirmado) <= 60
    ):
        return {"correcto": False, "mensaje": "La identidad del proyecto no es válida."}
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo leer el inventario de proyectos."}
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ] if isinstance(registro, list) else []
    if len(proyectos) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto importado."}
    proyecto = proyectos[0]
    if proyecto.get("nombre") != nombre_confirmado:
        return {"correcto": False, "mensaje": "El nombre de confirmación no coincide."}
    if proyecto.get("estado") == "archivado":
        return {"correcto": True, "nombre": nombre_confirmado, "baseDatosConservada": bool(proyecto.get("baseDatos"))}
    if proyecto.get("estado") not in {"desplegado", "pendiente_revision"}:
        return {"correcto": False, "mensaje": "El proyecto no puede archivarse desde su estado actual."}

    perfil = proyecto.get("runtimePerfil")
    ruta_runtime_segura = None
    if perfil not in (None, "php"):
        ruta_runtime = DIRECTORIO_RUNTIMES / identificador
        if DIRECTORIO_RUNTIMES.is_symlink() or ruta_runtime.is_symlink():
            return {"correcto": False, "mensaje": "La carpeta de runtime no es segura; no se eliminó."}
        try:
            raiz_runtimes = DIRECTORIO_RUNTIMES.resolve(strict=True)
            ruta_runtime_segura = ruta_runtime.resolve(strict=True)
            if ruta_runtime_segura.parent != raiz_runtimes or ruta_runtime_segura.name != identificador:
                return {"correcto": False, "mensaje": "La carpeta de runtime no coincide con el proyecto."}
        except FileNotFoundError:
            if proyecto.get("estado") == "desplegado":
                return {"correcto": False, "mensaje": "No se encontró la carpeta del runtime administrado."}
        except OSError:
            return {"correcto": False, "mensaje": "No se pudo validar la carpeta del runtime."}
    red = None
    if proyecto.get("estado") == "desplegado":
        if perfil in (None, "php"):
            runtime, error = validar_runtime_php(proyecto)
        else:
            runtime, error = validar_runtime_app(proyecto)
        if error:
            return {"correcto": False, "mensaje": error}
        red = runtime["red"]
        detener_proxy_php(identificador)
        retirado = ejecutar(["docker", "rm", "--force", runtime["contenedor"]])
        if retirado is None:
            return {"correcto": False, "mensaje": "No se pudo retirar el runtime del proyecto."}

    if ruta_runtime_segura is not None:
        shutil.rmtree(ruta_runtime_segura)

    for campo in (
        "runtime", "runtimePerfil", "puertoInterno", "puertoLocal",
        "contenedor", "idContenedor", "estadoRuntime", "rutaInicio",
    ):
        proyecto.pop(campo, None)
    proyecto["estado"] = "archivado"
    try:
        guardar_registro_proyectos(registro)
    except OSError:
        logging.exception("No se pudo guardar el archivo del proyecto %s.", identificador[:12])
        return {"correcto": False, "mensaje": "Se retiró el runtime, pero no se pudo guardar el estado archivado."}

    if not proyecto.get("baseDatos") and red:
        inspeccion = ejecutar(["docker", "network", "inspect", "--format", "{{json .}}", red])
        try:
            datos_red = json.loads(inspeccion) if inspeccion else {}
            etiquetas = datos_red.get("Labels", {})
            if (
                etiquetas.get("com.swatt.project-id") == identificador
                and etiquetas.get("com.swatt.managed") == (
                    "php-project" if perfil in (None, "php") else "application"
                )
                and datos_red.get("Internal") is True
            ):
                if ejecutar(["docker", "network", "rm", red]) is None:
                    logging.warning("No se pudo retirar la red aislada sin base del proyecto %s.", identificador[:12])
        except (TypeError, ValueError, json.JSONDecodeError):
            logging.warning("No se pudo validar la red al archivar el proyecto %s.", identificador[:12])
    return {
        "correcto": True,
        "nombre": nombre_confirmado,
        "baseDatosConservada": bool(proyecto.get("baseDatos")),
    }


def guardar_registro_proyectos(registro):
    """Guarda el estado del despliegue de forma atómica y con permisos privados."""
    DIRECTORIO_PROYECTOS.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor, temporal = tempfile.mkstemp(dir=DIRECTORIO_PROYECTOS, prefix=".registro-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
            json.dump(registro, archivo, ensure_ascii=False, indent=2)
            archivo.write("\n")
        os.chmod(temporal, 0o600)
        os.replace(temporal, DIRECTORIO_PROYECTOS / ".registro-swatt.json")
    finally:
        if os.path.exists(temporal):
            os.unlink(temporal)


def crear_servidor_proxy_php(puerto, ip_contenedor, puerto_interno=80):
    """Crea un proxy HTTP por aplicación, enlazado solamente a loopback."""
    try:
        direccion = ipaddress.ip_address(ip_contenedor)
    except ValueError as error:
        raise ValueError("La IP del contenedor no es válida.") from error
    if (
        direccion.version != 4
        or not direccion.is_private
        or direccion.is_loopback
        or direccion.is_link_local
        or type(puerto) is not int
        or not PUERTO_PHP_INICIAL <= puerto <= PUERTO_PHP_FINAL
        or type(puerto_interno) is not int
        or not 1 <= puerto_interno <= 65535
    ):
        raise ValueError("La dirección o el puerto del proxy no están dentro del rango privado esperado.")

    class ManejadorProxy(http.server.BaseHTTPRequestHandler):
        """Reenvía solicitudes HTTP al Apache de la red interna del proyecto."""

        protocol_version = "HTTP/1.1"
        server_version = "SwattProxy"
        sys_version = ""
        metodos_permitidos = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
        encabezados_salto = {
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
        }
        maximo_cuerpo = 8 * 1024 * 1024

        def setup(self):
            self.request.settimeout(10)
            super().setup()

        def log_message(self, _formato, *_argumentos):
            return

        def responder_error(self, estado, mensaje):
            cuerpo = mensaje.encode("utf-8")
            self.send_response(estado)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(cuerpo)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(cuerpo)
            self.close_connection = True

        def _reenviar(self):
            if self.command not in self.metodos_permitidos:
                self.responder_error(405, "Método no permitido.")
                return
            if not self.path.startswith("/") or self.path.startswith("//"):
                self.responder_error(400, "Ruta de solicitud inválida.")
                return
            transferencia = self.headers.get("Transfer-Encoding")
            if transferencia:
                self.responder_error(501, "No se admiten solicitudes codificadas por fragmentos.")
                return
            longitud_texto = self.headers.get("Content-Length", "0")
            try:
                longitud = int(longitud_texto)
            except ValueError:
                self.responder_error(400, "Longitud de solicitud inválida.")
                return
            if longitud < 0 or longitud > self.maximo_cuerpo:
                self.responder_error(413, "El cuerpo de solicitud supera 8 MiB.")
                return
            cuerpo = self.rfile.read(longitud) if longitud else None
            encabezados_salto = self.encabezados_salto | {
                elemento.strip().lower()
                for elemento in self.headers.get("Connection", "").split(",")
                if elemento.strip()
            }
            encabezados = {
                nombre: valor
                for nombre, valor in self.headers.items()
                if nombre.lower() not in encabezados_salto
                and nombre.lower() not in {"host", "content-length"}
            }
            if longitud:
                encabezados["Content-Length"] = str(longitud)
            encabezados["Host"] = f"{ip_contenedor}:{puerto_interno}"
            encabezados["Connection"] = "close"
            conexion = http.client.HTTPConnection(ip_contenedor, puerto_interno, timeout=15)
            encabezados_enviados = False
            try:
                conexion.request(self.command, self.path, body=cuerpo, headers=encabezados)
                respuesta = conexion.getresponse()
                self.send_response(respuesta.status, respuesta.reason)
                encabezados_enviados = True
                encabezados_salto_respuesta = self.encabezados_salto | {
                    elemento.strip().lower()
                    for elemento in (respuesta.getheader("Connection") or "").split(",")
                    if elemento.strip()
                }
                for nombre, valor in respuesta.getheaders():
                    if nombre.lower() not in encabezados_salto_respuesta | {"content-length", "server"}:
                        self.send_header(nombre, valor)
                longitud_respuesta = respuesta.length
                if longitud_respuesta is None:
                    self.send_header("Transfer-Encoding", "chunked")
                else:
                    self.send_header("Content-Length", str(longitud_respuesta))
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command != "HEAD":
                    while True:
                        fragmento = respuesta.read(64 * 1024)
                        if not fragmento:
                            break
                        if longitud_respuesta is None:
                            self.wfile.write(f"{len(fragmento):X}\r\n".encode("ascii"))
                            self.wfile.write(fragmento)
                            self.wfile.write(b"\r\n")
                        else:
                            self.wfile.write(fragmento)
                    if self.command != "HEAD" and longitud_respuesta is None:
                        self.wfile.write(b"0\r\n\r\n")
                self.close_connection = True
            except (OSError, http.client.HTTPException, TimeoutError):
                if not encabezados_enviados and not self.wfile.closed:
                    try:
                        self.responder_error(502, "El servidor PHP interno no está disponible.")
                    except OSError:
                        pass
            finally:
                conexion.close()

    for metodo in ManejadorProxy.metodos_permitidos:
        setattr(ManejadorProxy, f"do_{metodo}", ManejadorProxy._reenviar)

    class ServidorProxy(http.server.ThreadingHTTPServer):
        """Servidor multiproceso liviano para las respuestas HTTP de PHP."""

        daemon_threads = True
        allow_reuse_address = False

    return ServidorProxy(("127.0.0.1", puerto), ManejadorProxy)


def _leer_registro_tailscale():
    try:
        with ARCHIVO_TAILSCALE.open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except FileNotFoundError:
        return {}
    if not isinstance(registro, dict) or not isinstance(registro.get("proyectos"), dict):
        raise ValueError("El registro de accesos privados de Tailscale no es válido.")
    proyectos = registro["proyectos"]
    for identificador, entrada in proyectos.items():
        if (
            not isinstance(identificador, str)
            or not re.fullmatch(r"[a-f0-9-]{36}", identificador)
            or not isinstance(entrada, dict)
            or not isinstance(entrada.get("puerto"), int)
            or not 18080 <= entrada["puerto"] <= 18179
        ):
            raise ValueError("El registro de accesos privados de Tailscale contiene datos inválidos.")
    return proyectos


def _guardar_registro_tailscale(proyectos):
    ARCHIVO_TAILSCALE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, ruta_temporal = tempfile.mkstemp(
        dir=ARCHIVO_TAILSCALE.parent,
        prefix=".tailscale-",
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
            os.chmod(ruta_temporal, 0o600)
            json.dump({"proyectos": proyectos}, archivo)
            archivo.flush()
            os.fsync(archivo.fileno())
        os.replace(ruta_temporal, ARCHIVO_TAILSCALE)
    except OSError:
        try:
            os.unlink(ruta_temporal)
        except FileNotFoundError:
            pass
        raise


def _ejecutar_tailscale(argumentos):
    try:
        return subprocess.run(
            ["tailscale", *argumentos],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        detalle = getattr(error, "stderr", None) or str(error)
        raise ValueError(f"No se pudo configurar el acceso privado de Tailscale: {detalle[:200]}") from error


def habilitar_acceso_tailscale(identificador, puerto):
    """Expone por la tailnet un puerto administrado sin reemplazar rutas ajenas."""
    if not TAILSCALE_SERVE_HABILITADO:
        return
    if (
        not isinstance(identificador, str)
        or not re.fullmatch(r"[a-f0-9-]{36}", identificador)
        or not isinstance(puerto, int)
        or not 18080 <= puerto <= 18179
    ):
        raise ValueError("El puerto o el identificador del acceso privado no son válidos.")

    with cerradura_tailscale:
        proyectos = _leer_registro_tailscale()
        propietario = next(
            (id_proyecto for id_proyecto, entrada in proyectos.items() if entrada["puerto"] == puerto),
            None,
        )
        if propietario not in (None, identificador):
            raise ValueError("El puerto Tailscale ya está reservado por otra aplicación.")
        entrada_actual = proyectos.get(identificador)
        if entrada_actual and entrada_actual["puerto"] == puerto:
            return

        estado = _ejecutar_tailscale(["serve", "status", "--json"])
        try:
            configuracion = json.loads(estado.stdout)
        except json.JSONDecodeError as error:
            raise ValueError("Tailscale devolvió un estado de Serve que no se pudo interpretar.") from error
        puertos_tcp = configuracion.get("TCP", {}) if isinstance(configuracion, dict) else None
        if puertos_tcp is None:
            puertos_tcp = {}
        if not isinstance(puertos_tcp, dict):
            raise ValueError("La configuración TCP de Tailscale no tiene un formato compatible.")
        if str(puerto) in puertos_tcp and propietario != identificador:
            raise ValueError("El puerto Tailscale ya está configurado y no pertenece a esta aplicación.")

        _ejecutar_tailscale([
            "serve", "--bg", "--tcp", str(puerto), f"tcp://127.0.0.1:{puerto}",
        ])
        proyectos[identificador] = {"puerto": puerto}
        try:
            _guardar_registro_tailscale(proyectos)
        except OSError:
            _ejecutar_tailscale(["serve", "--tcp", str(puerto), "off"])
            raise


def deshabilitar_acceso_tailscale(identificador):
    """Retira solo el forwarding registrado para el proyecto indicado."""
    if not isinstance(identificador, str) or not re.fullmatch(r"[a-f0-9-]{36}", identificador):
        return
    with cerradura_tailscale:
        proyectos = _leer_registro_tailscale()
        entrada = proyectos.get(identificador)
        if not entrada:
            return
        puerto = entrada["puerto"]
        try:
            _ejecutar_tailscale(["serve", "--tcp", str(puerto), "off"])
            del proyectos[identificador]
            _guardar_registro_tailscale(proyectos)
        except (OSError, ValueError):
            logging.exception(
                "No se pudo retirar el forwarding Tailscale del proyecto %s en el puerto %s.",
                identificador[:12],
                puerto,
            )


def obtener_ip_tailscale():
    """Devuelve una IPv4 del rango de Tailscale para crear enlaces privados."""
    resultado = _ejecutar_tailscale(["ip", "-4"])
    try:
        direccion = ipaddress.ip_address(resultado.stdout.strip())
    except ValueError as error:
        raise ValueError("Tailscale no devolvió una dirección IPv4 válida.") from error
    if direccion.version != 4 or direccion not in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("La dirección del servidor no pertenece al rango IPv4 de Tailscale.")
    return str(direccion)


def iniciar_proxy_php(identificador, puerto, ip_contenedor, puerto_interno=80):
    """Inicia y registra un proxy local para una IP PHP verificada por Docker."""
    anterior = None
    with cerradura_proxies:
        existente = proxies_php.get(identificador)
        if existente:
            if existente["puerto"] != puerto:
                raise ValueError("El proyecto ya tiene un proxy en otro puerto.")
            if existente["ip"] == ip_contenedor and existente["hilo"].is_alive():
                return existente
            anterior = proxies_php.pop(identificador)
    if anterior:
        anterior["servidor"].shutdown()
        anterior["servidor"].server_close()
        anterior["hilo"].join(timeout=2)
    with cerradura_proxies:
        existente = proxies_php.get(identificador)
        if existente:
            if existente["puerto"] != puerto:
                raise ValueError("El proyecto ya tiene un proxy en otro puerto.")
            if existente["ip"] == ip_contenedor and existente["hilo"].is_alive():
                proxy = existente
            else:
                raise ValueError("No se pudo retirar el proxy anterior.")
        else:
            servidor = crear_servidor_proxy_php(puerto, ip_contenedor, puerto_interno)
            hilo = threading.Thread(
                target=servidor.serve_forever,
                name=f"proxy-php-{identificador[:8]}",
                daemon=True,
            )
            proxies_php[identificador] = {
                "puerto": puerto,
                "ip": ip_contenedor,
                "puerto_interno": puerto_interno,
                "servidor": servidor,
                "hilo": hilo,
            }
            hilo.start()
            proxy = proxies_php[identificador]
    try:
        if TAILSCALE_SERVE_HABILITADO:
            habilitar_acceso_tailscale(identificador, puerto)
        else:
            deshabilitar_acceso_tailscale(identificador)
    except (OSError, ValueError) as error:
        logging.error(
            "El proxy local del proyecto %s sigue activo, pero no se pudo sincronizar su acceso Tailscale: %s",
            identificador[:12],
            error,
        )
    return proxy


def detener_proxy_php(identificador):
    """Cierra el listener local de un proyecto sin tocar otras aplicaciones."""
    with cerradura_proxies:
        proxy = proxies_php.pop(identificador, None)
    if proxy:
        proxy["servidor"].shutdown()
        proxy["servidor"].server_close()
        proxy["hilo"].join(timeout=2)
    deshabilitar_acceso_tailscale(identificador)


def restaurar_proxies_php():
    """Restaura los proxies de proyectos activos tras reiniciar el agente."""
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except FileNotFoundError:
        return
    except (OSError, json.JSONDecodeError):
        logging.exception("No se pudieron cargar los proxies PHP guardados.")
        return
    if not isinstance(registro, list):
        logging.error("No se restauraron proxies PHP: el registro no es una lista.")
        return

    for proyecto in registro:
        if not isinstance(proyecto, dict) or proyecto.get("estado") != "desplegado":
            continue
        identificador = proyecto.get("id")
        es_app = proyecto.get("runtimePerfil") not in (None, "php")
        try:
            runtime, error = (
                validar_runtime_app(proyecto) if es_app else validar_runtime_php(proyecto)
            )
            if error:
                logging.warning("No se restauró PHP %s: %s", identificador[:12], error)
                continue
            if runtime["datos"]["State"]["Running"] is not True:
                logging.info("No se restauró PHP %s: el contenedor está detenido.", identificador[:12])
                continue
            iniciar_proxy_php(
                identificador,
                proyecto["puertoLocal"],
                runtime["ip"],
                proyecto.get("puertoInterno", 80),
            )
            logging.info("Proxy PHP restaurado para el proyecto %s.", identificador[:12])
        except (OSError, ValueError):
            logging.exception("No se pudo restaurar el proxy PHP %s.", identificador[:12])


def validar_runtime_php(proyecto):
    """Inspecciona imagen, etiquetas y red antes de controlar el contenedor."""
    if not isinstance(proyecto, dict):
        return None, "Los metadatos del runtime PHP no son válidos."
    identificador = proyecto.get("id")
    contenedor = proyecto.get("contenedor")
    puerto = proyecto.get("puertoLocal")
    if (
        not isinstance(identificador, str)
        or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", identificador)
        or contenedor != f"swatt-php-{identificador.replace('-', '')[:12]}"
        or not isinstance(proyecto.get("nombre"), str)
        or not 2 <= len(proyecto["nombre"]) <= 60
        or proyecto.get("runtime") != IMAGEN_PHP_APACHE
        or type(puerto) is not int
        or not PUERTO_PHP_INICIAL <= puerto <= PUERTO_PHP_FINAL
    ):
        return None, "Los metadatos del runtime PHP no son válidos."
    red_esperada = f"{NOMBRE_RED_PHP}{identificador.replace('-', '')[:12]}"
    salida = ejecutar(["docker", "inspect", "--format", "{{json .}}", contenedor])
    if salida is None:
        return None, "El contenedor PHP ya no existe en Docker."
    try:
        datos = json.loads(salida)
        if not isinstance(datos, dict):
            return None, "Docker devolvió una inspección PHP inválida."
        configuracion = datos["Config"]
        if not isinstance(configuracion, dict):
            return None, "Docker devolvió una configuración PHP inválida."
        etiquetas = configuracion["Labels"]
        estado_contenedor = datos["State"]
        redes_contenedor = datos["NetworkSettings"]
        if not isinstance(estado_contenedor, dict) or not isinstance(redes_contenedor, dict):
            return None, "Docker devolvió el estado o la red PHP inválidos."
        estado = estado_contenedor["Running"]
        redes = redes_contenedor["Networks"]
        if not isinstance(redes, dict):
            return None, "Docker devolvió una red PHP inválida."
        red = redes[red_esperada]
        if not isinstance(red, dict):
            return None, "Docker devolvió una interfaz PHP inválida."
        salida_red = ejecutar(["docker", "network", "inspect", "--format", "{{json .}}", red_esperada])
        datos_red = json.loads(salida_red) if salida_red else {}
        if not isinstance(datos_red, dict):
            return None, "Docker devolvió una inspección de red PHP inválida."
        etiquetas_red = datos_red.get("Labels")
        ip_contenedor = red.get("IPAddress")
        if isinstance(ip_contenedor, str) and ip_contenedor:
            direccion = ipaddress.ip_address(ip_contenedor)
            ip_valida = direccion.version == 4 and not direccion.is_global and not direccion.is_loopback
        elif estado is False:
            ip_contenedor = ""
            ip_valida = True
        else:
            ip_valida = False
        if (
            not isinstance(etiquetas, dict)
            or not isinstance(red, dict)
            or not isinstance(etiquetas_red, dict)
            or configuracion.get("Image") != IMAGEN_PHP_APACHE
            or etiquetas.get("com.swatt.managed") != "php-project"
            or etiquetas.get("com.swatt.project-id") != identificador
            or type(estado) is not bool
            or datos_red.get("Internal") is not True
            or etiquetas_red.get("com.swatt.project-id") != identificador
            or not ip_valida
        ):
            return None, "El contenedor o su red no coinciden con el runtime PHP administrado."
        return {
            "datos": datos,
            "ip": ip_contenedor,
            "red": red_esperada,
            "contenedor": contenedor,
        }, None
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None, "No se pudo validar la identidad del contenedor y la red PHP."


def validar_runtime_app(proyecto):
    """Verifica imagen, etiquetas y red aislada de un perfil gestionado."""
    if not isinstance(proyecto, dict):
        return None, "Los metadatos de la aplicación no son válidos."
    identificador = proyecto.get("id")
    perfil = proyecto.get("runtimePerfil")
    sufijo = identificador.replace("-", "")[:12] if isinstance(identificador, str) else ""
    red_esperada = f"{NOMBRE_RED_APP}{sufijo}"
    if (
        not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", identificador or "")
        or perfil not in PERFILES_RUNTIME
        or perfil == "php"
        or proyecto.get("contenedor") != f"swatt-app-{sufijo}"
        or proyecto.get("runtime") != PERFILES_RUNTIME[perfil]["imagen"]
        or type(proyecto.get("puertoLocal")) is not int
        or not PUERTO_PHP_INICIAL <= proyecto["puertoLocal"] <= PUERTO_PHP_FINAL
        or proyecto.get("puertoInterno") != PERFILES_RUNTIME[perfil]["puerto"]
    ):
        return None, "Los metadatos del runtime administrado no son válidos."
    salida = ejecutar(["docker", "inspect", "--format", "{{json .}}", proyecto["contenedor"]])
    if salida is None:
        return None, "El contenedor de la aplicación ya no existe en Docker."
    try:
        datos = json.loads(salida)
        configuracion = datos["Config"]
        etiquetas = configuracion["Labels"]
        estado = datos["State"]["Running"]
        redes = datos["NetworkSettings"]["Networks"]
        red = redes[red_esperada]
        salida_red = ejecutar(["docker", "network", "inspect", "--format", "{{json .}}", red_esperada])
        datos_red = json.loads(salida_red) if salida_red else {}
        ip = red.get("IPAddress")
        if isinstance(ip, str) and ip:
            direccion = ipaddress.ip_address(ip)
            ip_valida = (
                direccion.version == 4
                and direccion.is_private
                and not direccion.is_loopback
            )
        elif estado is False:
            ip = ""
            ip_valida = True
        else:
            ip_valida = False
        if (
            not isinstance(etiquetas, dict)
            or datos.get("Config", {}).get("Image") != PERFILES_RUNTIME[perfil]["imagen"]
            or etiquetas.get("com.swatt.managed") != "application"
            or etiquetas.get("com.swatt.project-id") != identificador
            or etiquetas.get("com.swatt.runtime") != perfil
            or type(estado) is not bool
            or datos_red.get("Internal") is not True
            or datos_red.get("Labels", {}).get("com.swatt.project-id") != identificador
            or not ip_valida
        ):
            return None, "El contenedor o la red no coinciden con el perfil gestionado."
        return {
            "datos": datos,
            "ip": ip,
            "red": red_esperada,
            "contenedor": proyecto["contenedor"],
        }, None
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None, "No se pudo validar la identidad del runtime de aplicación."


def runtime_monta_secreto_conexion(runtime):
    """Confirma que el contenedor administra la URL como montaje de solo lectura."""
    montajes = runtime["datos"].get("Mounts")
    return isinstance(montajes, list) and any(
        isinstance(montaje, dict)
        and montaje.get("Destination") == "/run/secrets/database-url"
        and montaje.get("RW") is False
        for montaje in montajes
    )


def consultar_estado_php():
    """Sincroniza el estado real de los runtimes y restaura sus proxies locales."""
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except FileNotFoundError:
        return {"correcto": True, "proyectos": []}
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo leer el inventario de proyectos."}
    if not isinstance(registro, list):
        return {"correcto": False, "mensaje": "El inventario de proyectos no es válido."}

    resultado = []
    cambios = False
    ip_tailscale = None
    puertos_tailscale = {}
    if TAILSCALE_SERVE_HABILITADO:
        try:
            ip_tailscale = obtener_ip_tailscale()
            puertos_tailscale = _leer_registro_tailscale()
        except (OSError, ValueError):
            logging.exception("No se pudieron consultar los enlaces privados de Tailscale.")
    for proyecto in registro:
        if not isinstance(proyecto, dict) or proyecto.get("estado") != "desplegado":
            continue
        es_app = proyecto.get("runtimePerfil") not in (None, "php")
        identificador = proyecto.get("id")
        if es_app:
            runtime, error = validar_runtime_app(proyecto)
        elif (
            not isinstance(identificador, str)
            or not re.fullmatch(r"[a-f0-9-]{36}", identificador)
            or proyecto.get("contenedor") != f"swatt-php-{identificador.replace('-', '')[:12]}"
        ):
            logging.error("No se consultó un runtime PHP con metadatos inválidos.")
            continue
        else:
            runtime, error = validar_runtime_php(proyecto)
        estado_anterior = proyecto.get("estadoRuntime", "activo")
        ruta_inicio = proyecto.get("rutaInicio", "")
        if (
            not isinstance(ruta_inicio, str)
            or len(ruta_inicio) > 512
            or ruta_inicio.startswith("/")
            or "\\" in ruta_inicio
            or "\x00" in ruta_inicio
            or any(parte in ("", ".", "..") for parte in ruta_inicio.split("/"))
        ):
            ruta_inicio = ""
        if error:
            estado = "no_disponible"
            detener_proxy_php(identificador)
        elif runtime["datos"]["State"]["Running"] is True:
            estado = "activo"
            try:
                proxy = proxies_php.get(identificador)
                if not proxy or proxy["ip"] != runtime["ip"] or not proxy["hilo"].is_alive():
                    detener_proxy_php(identificador)
                    iniciar_proxy_php(
                        identificador,
                        proyecto["puertoLocal"],
                        runtime["ip"],
                        proyecto.get("puertoInterno", 80),
                    )
                elif (
                    TAILSCALE_SERVE_HABILITADO
                    and puertos_tailscale.get(identificador, {}).get("puerto")
                    != proyecto["puertoLocal"]
                ):
                    try:
                        habilitar_acceso_tailscale(identificador, proyecto["puertoLocal"])
                    except (OSError, ValueError) as error:
                        logging.error(
                            "El runtime %s está activo, pero no se pudo sincronizar su acceso Tailscale: %s",
                            identificador[:12],
                            error,
                        )
            except (OSError, ValueError):
                logging.exception("No se pudo sincronizar el proxy PHP %s.", identificador[:12])
                estado = "no_disponible"
        else:
            estado = "detenido"
            detener_proxy_php(identificador)
        if estado_anterior != estado:
            proyecto["estadoRuntime"] = estado
            cambios = True
        ruta_datos_base = None
        base_datos = proyecto.get("baseDatos")
        if isinstance(base_datos, dict) and isinstance(base_datos.get("volumen"), str):
            salida_volumen = ejecutar([
                "docker", "volume", "inspect", "--format", "{{.Mountpoint}}",
                base_datos["volumen"],
            ])
            if isinstance(salida_volumen, str) and salida_volumen.startswith("/") and len(salida_volumen) <= 512:
                ruta_datos_base = salida_volumen
        resultado.append({
            "id": identificador,
            "nombre": proyecto["nombre"],
            "estado": estado,
            "puerto": proyecto["puertoLocal"],
            "rutaInicio": ruta_inicio,
            "rutaProyecto": str((DIRECTORIO_PROYECTOS / identificador).resolve()),
            "rutaRuntime": str(
                DIRECTORIO_RUNTIMES / identificador
                if es_app else (DIRECTORIO_PROYECTOS / identificador).resolve()
            ),
            "rutaDatos": ruta_datos_base,
            "urlPrivada": (
                f"http://{ip_tailscale}:{proyecto['puertoLocal']}"
                if (
                    ip_tailscale
                    and estado == "activo"
                    and isinstance(identificador, str)
                    and puertos_tailscale.get(identificador, {}).get("puerto")
                    == proyecto["puertoLocal"]
                )
                else None
            ),
        })

    if cambios:
        try:
            guardar_registro_proyectos(registro)
        except OSError:
            logging.exception("No se pudo guardar la sincronización de estados PHP.")
            return {"correcto": False, "mensaje": "No se pudieron guardar los estados actualizados."}
    return {"correcto": True, "proyectos": resultado}


def operar_runtime_php(solicitud):
    """Inicia, detiene o reinicia solo el PHP registrado y sincroniza su proxy."""
    validada, error = validar_solicitud_operacion_php(solicitud)
    if error:
        return {"correcto": False, "mensaje": error}
    accion, identificador, nombre_confirmado = validada
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo leer el inventario de proyectos."}
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ] if isinstance(registro, list) else []
    if len(proyectos) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto desplegado."}
    proyecto = proyectos[0]
    if proyecto.get("nombre") != nombre_confirmado:
        return {"correcto": False, "mensaje": "El nombre de confirmación no coincide."}
    if proyecto.get("runtimePerfil") not in (None, "php"):
        return operar_runtime_app(identificador, nombre_confirmado, accion, proyecto, registro)
    if proyecto.get("estado") != "desplegado":
        return {"correcto": False, "mensaje": "El proyecto no tiene un runtime PHP administrado."}
    runtime, error = validar_runtime_php(proyecto)
    if error:
        detener_proxy_php(identificador)
        return {"correcto": False, "mensaje": error}

    estado_actual = "activo" if runtime["datos"]["State"]["Running"] is True else "detenido"
    comando = {
        "php_iniciar": "start",
        "php_detener": "stop",
        "php_reiniciar": "restart",
    }[accion]
    if accion == "php_iniciar" and estado_actual == "activo":
        return {"correcto": False, "mensaje": "El proyecto ya está activo."}
    if accion == "php_detener" and estado_actual == "detenido":
        return {"correcto": False, "mensaje": "El proyecto ya está detenido."}

    if accion == "php_detener":
        resultado_docker = ejecutar(["docker", comando, "--time", "10", runtime["contenedor"]])
    else:
        resultado_docker = ejecutar(["docker", comando, runtime["contenedor"]])
    if resultado_docker is None:
        return {"correcto": False, "mensaje": "Docker no pudo completar la acción sobre PHP."}

    if accion == "php_detener":
        detener_proxy_php(identificador)
        proyecto["estadoRuntime"] = "detenido"
        estado_final = "detenido"
    else:
        datos_actualizados, error_actualizado = validar_runtime_php(proyecto)
        if error_actualizado or datos_actualizados["datos"]["State"]["Running"] is not True:
            return {"correcto": False, "mensaje": error_actualizado or "El contenedor no confirmó que esté activo."}
        try:
            detener_proxy_php(identificador)
            iniciar_proxy_php(identificador, proyecto["puertoLocal"], datos_actualizados["ip"])
        except (OSError, ValueError):
            logging.exception("No se pudo activar el proxy PHP %s.", identificador[:12])
            detener = ejecutar(["docker", "stop", "--time", "5", runtime["contenedor"]])
            if detener is None:
                logging.error("El contenedor PHP %s sigue activo sin proxy.", runtime["contenedor"])
            return {"correcto": False, "mensaje": "No se pudo restablecer el proxy del proyecto."}
        proyecto["estadoRuntime"] = "activo"
        estado_final = "activo"

    try:
        guardar_registro_proyectos(registro)
    except OSError:
        logging.exception("No se pudo guardar el estado PHP para el proyecto %s.", identificador[:12])
        if estado_final == "activo":
            detener_proxy_php(identificador)
            detener = ejecutar(["docker", "stop", "--time", "5", runtime["contenedor"]])
            if detener is None:
                logging.error("El contenedor PHP %s sigue activo tras un error del registro.", runtime["contenedor"])
        return {"correcto": False, "mensaje": "No se pudo guardar el nuevo estado del proyecto."}

    logging.info("Acción PHP %s completada para el proyecto %s.", accion, identificador[:12])
    return {
        "correcto": True,
        "nombre": nombre_confirmado,
        "estado": estado_final,
        "puerto": proyecto["puertoLocal"],
    }


def operar_runtime_app(identificador, nombre_confirmado, accion, proyecto, registro):
    """Controla acciones Docker limitadas del runtime genérico validado."""
    if proyecto.get("estado") != "desplegado":
        return {"correcto": False, "mensaje": "La aplicación no está desplegada."}
    runtime, error = validar_runtime_app(proyecto)
    if error:
        detener_proxy_php(identificador)
        return {"correcto": False, "mensaje": error}
    actual = runtime["datos"]["State"]["Running"]
    if accion == "php_iniciar" and actual:
        return {"correcto": False, "mensaje": "El proyecto ya está activo."}
    if accion == "php_detener" and not actual:
        return {"correcto": False, "mensaje": "El proyecto ya está detenido."}
    comando = {
        "php_iniciar": "start",
        "php_detener": "stop",
        "php_reiniciar": "restart",
    }[accion]
    resultado = ejecutar(["docker", comando, runtime["contenedor"]])
    if resultado is None:
        return {"correcto": False, "mensaje": "Docker no pudo completar la acción del proyecto."}
    if accion == "php_detener":
        detener_proxy_php(identificador)
        estado = "detenido"
    else:
        actualizado, error_actualizado = validar_runtime_app(proyecto)
        if error_actualizado or actualizado["datos"]["State"]["Running"] is not True:
            return {"correcto": False, "mensaje": error_actualizado or "El contenedor no confirmó que esté activo."}
        try:
            detener_proxy_php(identificador)
            iniciar_proxy_php(
                identificador,
                proyecto["puertoLocal"],
                actualizado["ip"],
                proyecto["puertoInterno"],
            )
        except (OSError, ValueError):
            logging.exception("No se pudo restablecer el proxy de la aplicación %s.", identificador[:12])
            return {"correcto": False, "mensaje": "No se pudo restablecer el proxy del proyecto."}
        estado = "activo"
    proyecto["estadoRuntime"] = estado
    try:
        guardar_registro_proyectos(registro)
    except OSError:
        logging.exception("No se pudo guardar el estado de la aplicación %s.", identificador[:12])
        return {"correcto": False, "mensaje": "No se pudo guardar el estado del proyecto."}
    return {
        "correcto": True,
        "nombre": nombre_confirmado,
        "estado": estado,
        "puerto": proyecto["puertoLocal"],
    }


def ejecutar_despliegue_php(solicitud):
    """Despliega solo el PHP importado usando una imagen fija y aislamiento limitado."""
    solicitud_validada, error = validar_solicitud_despliegue(solicitud)
    if error:
        return {"correcto": False, "mensaje": error}
    identificador, nombre_confirmado = solicitud_validada

    try:
        ruta_registro = DIRECTORIO_PROYECTOS / ".registro-swatt.json"
        with ruta_registro.open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el registro del proyecto."}
    if not isinstance(registro, list):
        return {"correcto": False, "mensaje": "El registro del proyecto no es válido."}
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ]
    if len(proyectos) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto importado."}
    proyecto = proyectos[0]
    if proyecto.get("nombre") != nombre_confirmado:
        return {"correcto": False, "mensaje": "El nombre de confirmación no coincide."}
    if proyecto.get("estado") != "pendiente_revision":
        return {"correcto": False, "mensaje": "El proyecto no está pendiente de revisión."}
    if sum(
        1 for elemento in registro
        if isinstance(elemento, dict) and elemento.get("estado") == "desplegado"
    ) >= MAXIMO_APLICACIONES_ADMINISTRADAS:
        return {"correcto": False, "mensaje": "Se alcanzó el límite de aplicaciones administradas en este servidor."}

    ruta_proyecto = DIRECTORIO_PROYECTOS / identificador
    try:
        if ruta_proyecto.is_symlink() or not ruta_proyecto.is_dir():
            return {"correcto": False, "mensaje": "La carpeta importada del proyecto no es válida."}
        ruta_inicio = encontrar_archivo_inicio(ruta_proyecto, "index.php")
        if ruta_inicio is None:
            return {
                "correcto": False,
                "mensaje": "PHP necesita un index.php en la raíz o un único index.php dentro de una subcarpeta.",
            }
        ruta_git = ruta_proyecto / ".git"
        if ruta_git.is_symlink():
            ruta_git.unlink()
        elif ruta_git.is_dir():
            shutil.rmtree(ruta_git)
        elif ruta_git.exists():
            ruta_git.unlink()
    except OSError:
        return {"correcto": False, "mensaje": "No se pudo validar el código importado."}

    nombre_contenedor = f"swatt-php-{identificador.replace('-', '')[:12]}"
    if ejecutar(["docker", "inspect", "--format", "{{.Id}}", nombre_contenedor]) is not None:
        return {"correcto": False, "mensaje": "Ya existe un contenedor con el identificador reservado para este proyecto."}

    if ejecutar(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGEN_PHP_APACHE]) is None:
        try:
            descarga = subprocess.run(
                ["docker", "pull", IMAGEN_PHP_APACHE],
                check=False,
                capture_output=True,
                text=True,
                timeout=180,
            )
        except subprocess.TimeoutExpired:
            return {"correcto": False, "mensaje": "La descarga de la imagen PHP superó el tiempo límite."}
        if descarga.returncode != 0:
            logging.warning("No se pudo descargar la imagen fija %s.", IMAGEN_PHP_APACHE)
            return {"correcto": False, "mensaje": "No se pudo descargar la imagen PHP/Apache necesaria."}

    red_proyecto = f"{NOMBRE_RED_PHP}{identificador.replace('-', '')[:12]}"
    etiquetas_red = ejecutar([
        "docker", "network", "inspect", "--format",
        '{{index .Labels "com.swatt.project-id"}}', red_proyecto,
    ])
    if etiquetas_red is None:
        try:
            crear_red = subprocess.run(
                [
                    "docker", "network", "create", "--driver", "bridge", "--internal",
                    "--label", "com.swatt.managed=php-project",
                    "--label", f"com.swatt.project-id={identificador}",
                    red_proyecto,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            return {"correcto": False, "mensaje": "La creación de la red aislada superó el tiempo límite."}
        if crear_red.returncode != 0:
            logging.warning("Docker no pudo crear la red aislada para el proyecto %s.", identificador[:12])
            return {"correcto": False, "mensaje": "No se pudo crear la red aislada del proyecto."}
        etiquetas_red = ejecutar([
            "docker", "network", "inspect", "--format",
            '{{index .Labels "com.swatt.project-id"}}', red_proyecto,
        ])
        if etiquetas_red != identificador:
            return {"correcto": False, "mensaje": "No se pudo verificar la red aislada del proyecto."}
    elif etiquetas_red != identificador:
        return {"correcto": False, "mensaje": "La red reservada para el proyecto no supera la validación de etiquetas."}

    salida_contenedores = ejecutar(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"])
    if salida_contenedores is None:
        return {"correcto": False, "mensaje": "No se pudieron comprobar los puertos disponibles."}
    try:
        contenedores = [json.loads(linea) for linea in salida_contenedores.splitlines()] if salida_contenedores else []
    except json.JSONDecodeError:
        return {"correcto": False, "mensaje": "No se pudieron comprobar los puertos disponibles."}
    puertos_ocupados = {
        puerto
        for contenedor in contenedores
        for puerto in range(PUERTO_PHP_INICIAL, PUERTO_PHP_FINAL + 1)
        if f":{puerto}->" in contenedor.get("Ports", "")
    }
    puertos_ocupados.update(
        proyecto.get("puertoLocal")
        for proyecto in registro
        if isinstance(proyecto, dict)
        and proyecto.get("estado") == "desplegado"
        and isinstance(proyecto.get("puertoLocal"), int)
        and PUERTO_PHP_INICIAL <= proyecto["puertoLocal"] <= PUERTO_PHP_FINAL
    )
    with cerradura_proxies:
        puertos_ocupados.update(proxy["puerto"] for proxy in proxies_php.values())
    puerto = next(
        (candidato for candidato in range(PUERTO_PHP_INICIAL, PUERTO_PHP_FINAL + 1)
         if candidato not in puertos_ocupados),
        None,
    )
    if puerto is None:
        return {"correcto": False, "mensaje": "No hay puertos libres en el rango reservado para aplicaciones PHP."}

    try:
        DIRECTORIO_SECRETOS.mkdir(mode=0o700, parents=True, exist_ok=True)
        if DIRECTORIO_SECRETOS.is_symlink() or not DIRECTORIO_SECRETOS.is_dir():
            return {"correcto": False, "mensaje": "El directorio protegido de secretos no es válido."}
        os.chmod(DIRECTORIO_SECRETOS, 0o700)
    except OSError:
        logging.exception("No se pudo preparar el directorio privado del proyecto %s.", identificador[:12])
        return {"correcto": False, "mensaje": "No se pudo preparar la configuración privada del proyecto."}
    directorio_secreto = DIRECTORIO_SECRETOS / identificador
    try:
        directorio_secreto.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directorio_secreto.is_symlink() or not directorio_secreto.is_dir():
            return {"correcto": False, "mensaje": "El directorio de conexión del proyecto no es válido."}
        os.chmod(directorio_secreto, 0o700)
        ruta_url = directorio_secreto / "database-url"
        if ruta_url.is_symlink() or (ruta_url.exists() and not ruta_url.is_file()):
            return {"correcto": False, "mensaje": "El archivo de conexión del proyecto no es válido."}
        if not ruta_url.exists():
            escribir_secreto(ruta_url, "", modo=0o644)
    except OSError:
        logging.exception("No se pudo preparar la ruta privada de conexión del proyecto %s.", identificador[:12])
        return {"correcto": False, "mensaje": "No se pudo preparar la configuración privada del proyecto."}
    argumentos = [
        "docker", "run", "--detach",
        "--name", nombre_contenedor,
        "--label", "com.swatt.managed=php-project",
        "--label", f"com.swatt.project-id={identificador}",
        "--restart", "unless-stopped",
        "--network", red_proyecto,
        "--mount", f"type=bind,source={ruta_proyecto},target=/var/www/html,readonly",
        "--mount", f"type=bind,source={ruta_url},target=/run/secrets/database-url,readonly",
        "--env", "DATABASE_URL_FILE=/run/secrets/database-url",
        "--env", "SWATT_DATABASE_URL_FILE=/run/secrets/database-url",
        "--memory", "256m",
        "--cpus", "0.50",
        "--pids-limit", "64",
        "--read-only",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--cap-add", "NET_BIND_SERVICE",
        "--cap-add", "SETUID",
        "--cap-add", "SETGID",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
        "--tmpfs", "/var/run/apache2:rw,noexec,nosuid,size=1m",
        "--tmpfs", "/var/lock/apache2:rw,noexec,nosuid,size=1m",
        "--tmpfs", "/var/lib/php/sessions:rw,noexec,nosuid,size=8m",
        IMAGEN_PHP_APACHE,
    ]
    try:
        resultado = subprocess.run(
            argumentos,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return {"correcto": False, "mensaje": "El contenedor PHP superó el tiempo límite de creación."}
    if resultado.returncode != 0:
        logging.warning("Docker rechazó la creación PHP para el proyecto %s.", identificador[:12])
        return {"correcto": False, "mensaje": "Docker no pudo iniciar el contenedor PHP aislado."}

    id_contenedor = resultado.stdout.strip()[:64]
    estado_contenedor = ejecutar(["docker", "inspect", "--format", "{{.State.Running}}", nombre_contenedor])
    if estado_contenedor != "true":
        return {"correcto": False, "mensaje": "El contenedor PHP no confirmó su estado activo."}

    inspeccion_contenedor = ejecutar([
        "docker", "inspect", "--format", "{{json .}}", nombre_contenedor,
    ])
    try:
        datos_contenedor = json.loads(inspeccion_contenedor) if inspeccion_contenedor else {}
        ip_contenedor = datos_contenedor["NetworkSettings"]["Networks"][red_proyecto]["IPAddress"]
        etiquetas = datos_contenedor["Config"]["Labels"]
        if (
            datos_contenedor["State"]["Running"] is not True
            or datos_contenedor["Config"]["Image"] != IMAGEN_PHP_APACHE
            or etiquetas.get("com.swatt.managed") != "php-project"
            or etiquetas.get("com.swatt.project-id") != identificador
            or not ip_contenedor
        ):
            raise ValueError("El contenedor no coincide con el runtime o la red esperada.")
        iniciar_proxy_php(identificador, puerto, ip_contenedor)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
        logging.exception("No se pudo iniciar el proxy local del proyecto %s.", identificador[:12])
        detener = ejecutar(["docker", "stop", "--time", "5", nombre_contenedor])
        if detener is None:
            logging.error("El contenedor PHP %s quedó activo sin proxy local.", nombre_contenedor)
        return {"correcto": False, "mensaje": "No se pudo iniciar el proxy local; se intentó detener el contenedor."}

    proyecto["estado"] = "desplegado"
    proyecto["runtime"] = "php:8.3-apache"
    proyecto["puertoInterno"] = 80
    proyecto["puertoLocal"] = puerto
    proyecto["contenedor"] = nombre_contenedor
    proyecto["idContenedor"] = id_contenedor
    proyecto["estadoRuntime"] = "activo"
    proyecto["rutaInicio"] = ruta_inicio
    try:
        guardar_registro_proyectos(registro)
    except OSError:
        logging.exception("No se pudo guardar el estado desplegado para el proyecto %s.", identificador[:12])
        detener_proxy_php(identificador)
        detener = ejecutar(["docker", "stop", "--time", "5", nombre_contenedor])
        if detener is None:
            logging.error("El contenedor PHP %s quedó activo pese al fallo del registro.", nombre_contenedor)
        return {"correcto": False, "mensaje": "No se pudo guardar el despliegue; se intentó detener el contenedor."}

    logging.info("Proyecto PHP %s desplegado en el puerto local %s.", identificador[:12], puerto)
    return {
        "correcto": True,
        "nombre": nombre_confirmado,
        "puerto": puerto,
        "contenedor": nombre_contenedor,
        "rutaInicio": ruta_inicio,
    }


def validar_solicitud_despliegue_app(solicitud):
    """Admite solo perfiles de despliegue definidos en el agente."""
    if not isinstance(solicitud, dict) or solicitud.get("accion") != "desplegar_app":
        return None, "acción de despliegue no permitida"
    identificador = solicitud.get("id")
    nombre = solicitud.get("nombreConfirmado")
    perfil = solicitud.get("perfil")
    if not isinstance(identificador, str) or not re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
        identificador,
        re.IGNORECASE,
    ):
        return None, "identificador de proyecto inválido"
    if not isinstance(nombre, str) or not 2 <= len(nombre) <= 60:
        return None, "nombre de confirmación inválido"
    if not isinstance(perfil, str) or perfil not in PERFILES_RUNTIME:
        return None, "perfil de runtime no permitido"
    return (identificador.lower(), nombre, perfil), None


def preparar_fuente_runtime(origen, destino):
    """Copia solo archivos regulares del repositorio y excluye secretos locales."""
    excluir = {".git", "node_modules", "vendor", "target", "build", "dist", ".venv"}
    for actual, directorios, archivos in os.walk(origen, followlinks=False):
        ruta_actual = pathlib.Path(actual)
        for nombre in list(directorios):
            ruta = ruta_actual / nombre
            if nombre in excluir:
                directorios.remove(nombre)
            elif ruta.is_symlink():
                raise ValueError("El repositorio contiene enlaces simbólicos no permitidos.")
        for nombre in archivos:
            origen_archivo = ruta_actual / nombre
            if origen_archivo.is_symlink():
                raise ValueError("El repositorio contiene enlaces simbólicos no permitidos.")
            if nombre == ".env" or (nombre.startswith(".env.") and nombre != ".env.example"):
                continue
            if nombre.lower().endswith((".pem", ".key", ".p12", ".pfx")):
                continue
            relativo = origen_archivo.relative_to(origen)
            destino_archivo = destino / relativo
            destino_archivo.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            shutil.copyfile(origen_archivo, destino_archivo)
            os.chmod(destino_archivo, 0o644)
    for actual, directorios, _archivos in os.walk(destino):
        os.chmod(actual, 0o755)


def encontrar_archivo_inicio(ruta, nombre_archivo):
    """Busca un único punto de entrada y prioriza el ubicado en la raíz."""
    raiz = pathlib.Path(ruta)
    entrada_raiz = raiz / nombre_archivo
    if entrada_raiz.is_file() and not entrada_raiz.is_symlink():
        return nombre_archivo

    excluidos = {".git", ".vs", "node_modules", "vendor", "target", "build", "dist", ".venv"}
    candidatos = []
    for actual, directorios, archivos in os.walk(raiz, followlinks=False):
        directorios[:] = [
            nombre for nombre in directorios
            if nombre not in excluidos and not (pathlib.Path(actual) / nombre).is_symlink()
        ]
        for nombre in archivos:
            archivo = pathlib.Path(actual) / nombre
            if nombre.lower() == nombre_archivo and not archivo.is_symlink():
                candidatos.append(archivo.relative_to(raiz).as_posix())
    return candidatos[0] if len(candidatos) == 1 else None


def cargar_perfil_proyecto(ruta, perfil):
    """Valida los archivos de entrada y produce comandos fijos para cada perfil."""
    ficheros = {elemento.name for elemento in ruta.iterdir() if elemento.is_file()}
    ejecutables = {
        "html": ({"index.html"}, ["nginx", "-g", "daemon off; pid /tmp/nginx.pid;"]),
        "php": ({"index.php"}, []),
        "node": ({"package.json"}, ["npm", "start"]),
        "react": ({"package.json", "package-lock.json"}, ["nginx", "-g", "daemon off; pid /tmp/nginx.pid;"]),
        "python": ({"app.py", "requirements.txt"}, ["python", "app.py"]),
        "ruby": ({"Gemfile", "config.ru"}, ["bundle", "exec", "rackup", "--host", "0.0.0.0", "--port", "3000"]),
        "java": ({"pom.xml"}, []),
        "kotlin": ({"pom.xml"}, []),
        "go": ({"go.mod", "main.go"}, ["/app/source/swatt-app"]),
        "rust": ({"Cargo.toml"}, ["/app/swatt-app"]),
    }
    requeridos, comando = ejecutables[perfil]
    ruta_inicio = None
    if perfil in {"html", "php"}:
        nombre_indice = "index.html" if perfil == "html" else "index.php"
        ruta_inicio = encontrar_archivo_inicio(ruta, nombre_indice)
        if ruta_inicio is None:
            perfil_alternativo = "php" if perfil == "html" else "html"
            indice_alternativo = "index.php" if perfil == "html" else "index.html"
            if encontrar_archivo_inicio(ruta, indice_alternativo):
                return None, (
                    f"No se encontró {nombre_indice}. Este proyecto contiene "
                    f"{indice_alternativo}; selecciona el perfil {perfil_alternativo.upper()}."
                )
            return None, (
                f"El perfil {perfil} requiere {nombre_indice} en la raíz o "
                f"exactamente un {nombre_indice} dentro de las subcarpetas."
            )
    elif not requeridos.issubset(ficheros):
        return None, f"El perfil {perfil} requiere estos archivos en la raíz: {', '.join(sorted(requeridos))}."
    if perfil == "node":
        try:
            manifiesto = json.loads((ruta / "package.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None, "package.json no es un JSON válido."
        if not isinstance(manifiesto, dict) or not isinstance(manifiesto.get("scripts"), dict) or not isinstance(
            manifiesto["scripts"].get("start"), str
        ):
            return None, "package.json debe declarar un script start."
        return {"comando": comando, "puerto": 3000, "rutaInicio": ruta_inicio}, None
    if perfil == "react":
        try:
            manifiesto = json.loads((ruta / "package.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None, "package.json no es un JSON válido."
        if not isinstance(manifiesto, dict) or not isinstance(manifiesto.get("scripts"), dict) or not isinstance(
            manifiesto["scripts"].get("build"), str
        ):
            return None, "package.json debe declarar un script build."
        return {"comando": comando, "puerto": 8080, "rutaInicio": ruta_inicio}, None
    if perfil in {"java", "kotlin"}:
        return {"comando": comando, "puerto": 8080, "rutaInicio": ruta_inicio}, None
    puerto = PERFILES_RUNTIME[perfil]["puerto"]
    if perfil == "python" and "requirements.txt" not in ficheros:
        return None, "Python requiere app.py y requirements.txt."
    return {"comando": comando, "puerto": puerto, "rutaInicio": ruta_inicio}, None


def ejecutar_compilacion_runtime(perfil, ruta):
    """Compila o instala dependencias en imágenes fijas y sandbox limitados."""
    comandos = {
        "node": ("node:22-bookworm-slim", ["npm", "install"]),
        "react": ("node:22-bookworm-slim", ["sh", "-c", "npm ci && npm run build"]),
        "python": ("python:3.12-slim", ["sh", "-c", "pip install --disable-pip-version-check --target /workspace/.swatt-packages -r requirements.txt"]),
        "ruby": ("ruby:3.3-slim", ["sh", "-c", "bundle config set --local path vendor/bundle && bundle install"]),
        "java": ("maven:3.9-eclipse-temurin-21", ["mvn", "-B", "-DskipTests", "package"]),
        "kotlin": ("maven:3.9-eclipse-temurin-21", ["mvn", "-B", "-DskipTests", "package"]),
        "go": ("golang:1.24-bookworm", ["go", "build", "-o", "/workspace/swatt-app", "."]),
        "rust": ("rust:1.86-bookworm", ["cargo", "build", "--release"]),
    }
    if perfil not in comandos:
        return None, None
    imagen, comando = comandos[perfil]
    if perfil == "rust":
        try:
            manifiesto = tomllib.loads((ruta / "Cargo.toml").read_text(encoding="utf-8"))
            nombre_binario = manifiesto.get("package", {}).get("name")
            if not isinstance(nombre_binario, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", nombre_binario):
                return None, "Cargo.toml requiere un nombre de paquete seguro."
            comando = ["sh", "-c", f"cargo build --release && cp target/release/{nombre_binario.replace('-', '_')} /workspace/swatt-app"]
        except (OSError, tomllib.TOMLDecodeError, AttributeError):
            return None, "Cargo.toml no contiene un paquete válido."
    if perfil == "java" or perfil == "kotlin":
        wrapper = ruta / "mvnw"
        if wrapper.is_symlink():
            return None, "El wrapper Maven no puede ser un enlace simbólico."
        if wrapper.is_file():
            os.chmod(wrapper, 0o755)
            comando = ["./mvnw", "-B", "-DskipTests", "package"]
    uid = os.getuid() if hasattr(os, "getuid") else 1000
    gid = os.getgid() if hasattr(os, "getgid") else 1000
    argumentos = [
        "docker", "run", "--rm",
        "--network", "bridge",
        "--memory", "1536m",
        "--cpus", "1.25",
        "--pids-limit", "256",
        "--read-only",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--user", f"{uid}:{gid}",
        "--workdir", "/workspace",
        "--mount", f"type=bind,source={ruta},target=/workspace",
        "--env", "HOME=/workspace/.home",
        imagen,
        *comando,
    ]
    try:
        resultado = subprocess.run(
            argumentos,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
    except subprocess.TimeoutExpired:
        return None, "La compilación superó el límite de 15 minutos."
    if resultado.returncode != 0:
        detalle = (resultado.stderr or resultado.stdout or "")[-500:]
        logging.warning("Falló la compilación de %s: %s", perfil, detalle)
        return None, f"No se pudo compilar el perfil {perfil}; revisa el manifiesto y las dependencias."
    return imagen, None


def crear_configuracion_nginx_estatica(ruta_configuracion, es_react):
    """Escribe la configuración Nginx segura para los perfiles HTML y React."""
    ruta_configuracion.mkdir(mode=0o755)
    destino_no_encontrado = "/index.html" if es_react else "=404"
    configuracion = (
        "client_body_temp_path /tmp/client_temp;\n"
        "proxy_temp_path /tmp/proxy_temp;\n"
        "fastcgi_temp_path /tmp/fastcgi_temp;\n"
        "uwsgi_temp_path /tmp/uwsgi_temp;\n"
        "scgi_temp_path /tmp/scgi_temp;\n"
        "server {\n"
        "  listen 8080;\n"
        "  root /usr/share/nginx/html;\n"
        "  index index.html;\n"
        f"  location / {{ try_files $uri $uri/ {destino_no_encontrado}; }}\n"
        "}\n"
    )
    (ruta_configuracion / "swatt.conf").write_text(configuracion, encoding="utf-8")


def ejecutar_despliegue_app(solicitud):
    """Despliega aplicaciones con un perfil fijo, build acotado y red privada."""
    validada, error = validar_solicitud_despliegue_app(solicitud)
    if error:
        return {"correcto": False, "mensaje": error}
    identificador, nombre_confirmado, perfil = validada
    if perfil == "php":
        return ejecutar_despliegue_php({
            "accion": "desplegar_php",
            "id": identificador,
            "nombreConfirmado": nombre_confirmado,
        })
    try:
        ruta_registro = DIRECTORIO_PROYECTOS / ".registro-swatt.json"
        with ruta_registro.open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el registro del proyecto."}
    if not isinstance(registro, list):
        return {"correcto": False, "mensaje": "El registro del proyecto no es válido."}
    coincidencias = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ]
    if len(coincidencias) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto importado."}
    proyecto = coincidencias[0]
    if proyecto.get("nombre") != nombre_confirmado or proyecto.get("estado") != "pendiente_revision":
        return {"correcto": False, "mensaje": "El proyecto no está pendiente de revisión o el nombre no coincide."}
    if sum(
        1 for elemento in registro
        if isinstance(elemento, dict) and elemento.get("estado") == "desplegado"
    ) >= MAXIMO_APLICACIONES_ADMINISTRADAS:
        return {"correcto": False, "mensaje": "Se alcanzó el límite de aplicaciones administradas."}
    ruta_origen = DIRECTORIO_PROYECTOS / identificador
    ruta_runtime = DIRECTORIO_RUNTIMES / identificador
    ruta_fuente = ruta_runtime / "source"
    try:
        if ruta_origen.is_symlink() or not ruta_origen.is_dir():
            return {"correcto": False, "mensaje": "La carpeta importada no es válida."}
        DIRECTORIO_RUNTIMES.mkdir(mode=0o700, parents=True, exist_ok=True)
        if DIRECTORIO_RUNTIMES.is_symlink() or not DIRECTORIO_RUNTIMES.is_dir():
            raise ValueError("El directorio de runtimes no es seguro.")
        os.chmod(DIRECTORIO_RUNTIMES, 0o700)
        ruta_runtime.mkdir(mode=0o700)
        os.chmod(ruta_runtime, 0o755)
        DIRECTORIO_SECRETOS.mkdir(mode=0o700, parents=True, exist_ok=True)
        if DIRECTORIO_SECRETOS.is_symlink() or not DIRECTORIO_SECRETOS.is_dir():
            raise ValueError("El directorio de secretos no es seguro.")
        os.chmod(DIRECTORIO_SECRETOS, 0o700)
        directorio_secreto = DIRECTORIO_SECRETOS / identificador
        directorio_secreto.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directorio_secreto.is_symlink() or not directorio_secreto.is_dir():
            raise ValueError("El directorio de secretos no es seguro.")
        ruta_url = directorio_secreto / "database-url"
        if ruta_url.is_symlink() or (ruta_url.exists() and not ruta_url.is_file()):
            raise ValueError("El archivo de conexión no es seguro.")
        if not ruta_url.exists():
            escribir_secreto(ruta_url, "", modo=0o644)
        preparar_fuente_runtime(ruta_origen, ruta_fuente)
        configuracion, error_perfil = cargar_perfil_proyecto(ruta_fuente, perfil)
        if error_perfil:
            shutil.rmtree(ruta_runtime)
            return {"correcto": False, "mensaje": error_perfil}
    except (OSError, ValueError):
        logging.exception("No se pudo preparar la fuente del proyecto %s.", identificador[:12])
        shutil.rmtree(ruta_runtime, ignore_errors=True)
        return {"correcto": False, "mensaje": "No se pudo preparar la fuente segura del proyecto."}

    imagen_builder, error_build = ejecutar_compilacion_runtime(perfil, ruta_fuente)
    if error_build:
        shutil.rmtree(ruta_runtime, ignore_errors=True)
        return {"correcto": False, "mensaje": error_build}
    sufijo = identificador.replace("-", "")[:12]
    nombre_contenedor = f"swatt-app-{sufijo}"
    nombre_red = f"{NOMBRE_RED_APP}{sufijo}"
    inspeccion_red = ejecutar([
        "docker", "network", "inspect", "--format", "{{json .}}", nombre_red,
    ])
    red_reutilizada = inspeccion_red is not None
    if red_reutilizada:
        try:
            datos_red = json.loads(inspeccion_red)
            etiquetas_red = datos_red.get("Labels", {})
            if (
                not proyecto.get("baseDatos")
                or etiquetas_red.get("com.swatt.project-id") != identificador
                or etiquetas_red.get("com.swatt.managed") != "application"
                or datos_red.get("Internal") is not True
            ):
                shutil.rmtree(ruta_runtime, ignore_errors=True)
                return {"correcto": False, "mensaje": "La red existente no pertenece a una actualización con base de datos."}
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
            shutil.rmtree(ruta_runtime, ignore_errors=True)
            return {"correcto": False, "mensaje": "No se pudo validar la red existente del proyecto."}
    perfil_runtime = PERFILES_RUNTIME[perfil]
    imagen = perfil_runtime["imagen"]
    if imagen_builder:
        imagen = {
            "node": "node:22-bookworm-slim",
            "react": "nginx:1.27-alpine",
            "python": "python:3.12-slim",
            "ruby": "ruby:3.3-slim",
            "java": "eclipse-temurin:21-jre",
            "kotlin": "eclipse-temurin:21-jre",
            "go": "gcr.io/distroless/base-debian12:nonroot",
            "rust": "gcr.io/distroless/cc-debian12:nonroot",
        }[perfil]
    if ejecutar(["docker", "image", "inspect", "--format", "{{.Id}}", imagen]) is None:
        try:
            descarga = subprocess.run(
                ["docker", "pull", imagen],
                check=False,
                capture_output=True,
                text=True,
                timeout=300,
            )
        except (OSError, subprocess.TimeoutExpired):
            return {"correcto": False, "mensaje": "La descarga de la imagen de runtime superó el límite de tiempo."}
        if descarga.returncode != 0:
            return {"correcto": False, "mensaje": "No se pudo descargar la imagen fija del runtime."}

    if perfil == "react":
        ruta_salida = ruta_fuente / ("dist" if (ruta_fuente / "dist").is_dir() else "build")
        if ruta_salida.is_symlink() or not ruta_salida.is_dir():
            return {"correcto": False, "mensaje": "La compilación React debe producir la carpeta dist/ o build/."}
        webroot = ruta_salida
        configuracion_nginx = ruta_runtime / "nginx"
        crear_configuracion_nginx_estatica(configuracion_nginx, True)
        ruta_runtime_app = webroot
        puerto_interno = 8080
    elif perfil == "html":
        ruta_runtime_app = ruta_fuente
        puerto_interno = 8080
        configuracion_nginx = ruta_runtime / "nginx"
        crear_configuracion_nginx_estatica(configuracion_nginx, False)
    else:
        ruta_runtime_app = ruta_fuente
        puerto_interno = configuracion["puerto"]
    comando = configuracion["comando"]
    if perfil in {"html", "react"}:
        comando = list(COMANDO_NGINX_ESTATICO)
    elif perfil == "java" or perfil == "kotlin":
        candidatos = [
            item for item in (ruta_fuente / "target").glob("*.jar")
            if item.is_file()
            and not item.is_symlink()
            and not item.name.endswith(("-sources.jar", "-javadoc.jar", "-original.jar"))
        ] if (ruta_fuente / "target").is_dir() else []
        if len(candidatos) != 1 or not zipfile.is_zipfile(candidatos[0]):
            return {"correcto": False, "mensaje": "Maven debe producir exactamente un JAR ejecutable en target/."}
        try:
            with zipfile.ZipFile(candidatos[0]) as archivo_jar:
                manifiesto = archivo_jar.read("META-INF/MANIFEST.MF").decode("utf-8", errors="replace")
        except (OSError, KeyError, zipfile.BadZipFile):
            return {"correcto": False, "mensaje": "No se pudo leer el manifiesto del JAR compilado."}
        if not re.search(r"(?m)^Main-Class:\s*\S+", manifiesto):
            return {"correcto": False, "mensaje": "El manifiesto del JAR debe declarar Main-Class."}
        comando = ["java", "-jar", f"/app/source/target/{candidatos[0].name}"]
    elif perfil == "rust":
        comando = ["/app/source/swatt-app"]
    elif perfil == "python":
        comando = ["python", "app.py"]
    puertos_ocupados = set()
    salida_contenedores = ejecutar(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"])
    if salida_contenedores is None:
        return {"correcto": False, "mensaje": "No se pudo consultar Docker para reservar un puerto."}
    for linea in salida_contenedores.splitlines():
        try:
            info = json.loads(linea)
            puertos_ocupados.update(
                candidato for candidato in range(PUERTO_PHP_INICIAL, PUERTO_PHP_FINAL + 1)
                if f":{candidato}->" in info.get("Ports", "")
            )
        except json.JSONDecodeError:
            return {"correcto": False, "mensaje": "Docker devolvió una lista de contenedores inválida."}
    puertos_ocupados.update(
        proyecto.get("puertoLocal") for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("estado") == "desplegado"
        and isinstance(proyecto.get("puertoLocal"), int)
    )
    puerto = next(
        (candidato for candidato in range(PUERTO_PHP_INICIAL, PUERTO_PHP_FINAL + 1)
         if candidato not in puertos_ocupados),
        None,
    )
    if puerto is None:
        return {"correcto": False, "mensaje": "No hay puertos locales reservados disponibles."}
    if not red_reutilizada:
        try:
            crear_red = subprocess.run(
                [
                    "docker", "network", "create", "--driver", "bridge", "--internal",
                    "--label", "com.swatt.managed=application",
                    "--label", f"com.swatt.project-id={identificador}",
                    nombre_red,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired):
            shutil.rmtree(ruta_runtime, ignore_errors=True)
            return {"correcto": False, "mensaje": "No se pudo crear la red del proyecto."}
        if crear_red.returncode != 0:
            shutil.rmtree(ruta_runtime, ignore_errors=True)
            return {"correcto": False, "mensaje": "Docker rechazó la creación de la red del proyecto."}

    def retirar_red_proyecto():
        if red_reutilizada:
            return
        propietario = ejecutar([
            "docker", "network", "inspect", "--format",
            '{{index .Labels "com.swatt.project-id"}}', nombre_red,
        ])
        if propietario is None:
            logging.error("No se pudo validar la red privada incompleta %s para retirarla.", nombre_red)
            return
        if propietario == identificador:
            try:
                retiro = subprocess.run(
                    ["docker", "network", "rm", nombre_red],
                    check=False,
                    capture_output=True,
                    timeout=30,
                )
                if retiro.returncode != 0:
                    logging.error("No se pudo retirar la red privada incompleta %s.", nombre_red)
            except (OSError, subprocess.TimeoutExpired):
                logging.exception("Falló la limpieza de la red privada incompleta %s.", nombre_red)
        else:
            logging.error("Se conservó la red %s porque sus etiquetas no coinciden.", nombre_red)

    if ejecutar([
        "docker", "network", "inspect", "--format",
        '{{index .Labels "com.swatt.project-id"}}', nombre_red,
    ]) != identificador:
        retirar_red_proyecto()
        shutil.rmtree(ruta_runtime, ignore_errors=True)
        return {"correcto": False, "mensaje": "La red recién creada no superó la validación."}
    argumentos = [
        "docker", "run", "--detach",
        "--name", nombre_contenedor,
        "--label", "com.swatt.managed=application",
        "--label", f"com.swatt.project-id={identificador}",
        "--label", f"com.swatt.runtime={perfil}",
        "--restart", "unless-stopped",
        "--network", nombre_red,
        "--mount", f"type=bind,source={ruta_runtime},target=/app,readonly",
        "--memory", "512m",
        "--cpus", "0.50",
        "--pids-limit", "128",
        "--read-only",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        *OPCIONES_TMPFS_RUNTIME,
        "--user", "10001:10001",
        "--env", f"PORT={puerto_interno}",
    ]
    if perfil == "python":
        argumentos.extend(["--env", "PYTHONPATH=/app/source/.swatt-packages"])
    ruta_url = DIRECTORIO_SECRETOS / identificador / "database-url"
    argumentos.extend([
        "--mount", f"type=bind,source={ruta_url},target=/run/secrets/database-url,readonly",
        "--env", "DATABASE_URL_FILE=/run/secrets/database-url",
        "--env", "SWATT_DATABASE_URL_FILE=/run/secrets/database-url",
    ])
    if perfil == "html" or perfil == "react":
        argumentos.extend([
            "--mount", f"type=bind,source={ruta_runtime_app},target=/usr/share/nginx/html,readonly",
            "--mount", f"type=bind,source={configuracion_nginx},target=/etc/nginx/conf.d,readonly",
        ])
    else:
        argumentos.extend(["--workdir", "/app/source"])
    argumentos.extend([imagen, *comando])
    try:
        inicio = subprocess.run(
            argumentos,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        retirar_red_proyecto()
        shutil.rmtree(ruta_runtime, ignore_errors=True)
        return {"correcto": False, "mensaje": "No se pudo iniciar el contenedor seguro."}
    if inicio.returncode != 0:
        logging.warning("Docker rechazó el runtime %s del proyecto %s.", perfil, identificador[:12])
        retirar_red_proyecto()
        shutil.rmtree(ruta_runtime, ignore_errors=True)
        return {"correcto": False, "mensaje": "Docker no pudo iniciar el contenedor del proyecto."}
    inspeccion = ejecutar(["docker", "inspect", "--format", "{{json .}}", nombre_contenedor])
    try:
        datos = json.loads(inspeccion) if inspeccion else {}
        red_info = datos["NetworkSettings"]["Networks"][nombre_red]
        etiqueta = datos["Config"]["Labels"]
        ip_contenedor = red_info["IPAddress"]
        if (
            datos["State"]["Running"] is not True
            or datos["Config"]["Image"] != imagen
            or etiqueta.get("com.swatt.project-id") != identificador
            or etiqueta.get("com.swatt.runtime") != perfil
            or not ipaddress.ip_address(ip_contenedor).is_private
        ):
            raise ValueError("Docker inspect no coincide con el perfil esperado.")
        iniciar_proxy_php(identificador, puerto, ip_contenedor, puerto_interno)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
        logging.exception("No se pudo validar el contenedor del proyecto %s.", identificador[:12])
        subprocess.run(["docker", "rm", "--force", nombre_contenedor], check=False, capture_output=True, timeout=30)
        retirar_red_proyecto()
        shutil.rmtree(ruta_runtime, ignore_errors=True)
        return {"correcto": False, "mensaje": "El runtime no superó la verificación; se retiró el contenedor."}
    proyecto.update({
        "estado": "desplegado",
        "runtime": imagen,
        "runtimePerfil": perfil,
        "puertoLocal": puerto,
        "puertoInterno": puerto_interno,
        "rutaInicio": configuracion.get("rutaInicio") or "",
        "contenedor": nombre_contenedor,
        "estadoRuntime": "activo",
    })
    try:
        guardar_registro_proyectos(registro)
    except OSError:
        detener_proxy_php(identificador)
        subprocess.run(["docker", "rm", "--force", nombre_contenedor], check=False, capture_output=True, timeout=30)
        retirar_red_proyecto()
        shutil.rmtree(ruta_runtime, ignore_errors=True)
        return {"correcto": False, "mensaje": "No se pudo guardar el registro de despliegue."}
    return {
        "correcto": True,
        "nombre": nombre_confirmado,
        "perfil": perfil,
        "puerto": puerto,
        "rutaInicio": configuracion.get("rutaInicio") or "",
    }


def validar_solicitud_base_datos(solicitud):
    """Limita la creación de base de datos a motores y proyectos conocidos."""
    if not isinstance(solicitud, dict) or solicitud.get("accion") != "crear_base_datos":
        return None, "acción de base de datos no permitida"
    identificador = solicitud.get("id")
    nombre_confirmado = solicitud.get("nombreConfirmado")
    motor = solicitud.get("motor")
    if not isinstance(identificador, str) or not re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
        identificador,
        re.IGNORECASE,
    ):
        return None, "identificador de proyecto inválido"
    if not isinstance(nombre_confirmado, str) or not 2 <= len(nombre_confirmado) <= 60:
        return None, "nombre de confirmación inválido"
    if not isinstance(motor, str) or motor not in MOTORES_BASES_DATOS:
        return None, "motor de base de datos no permitido"
    nombre_base = solicitud.get("nombreBaseDatos", MOTORES_BASES_DATOS[motor]["nombre_base"])
    if motor == "redis":
        if nombre_base != "0":
            return None, "Redis solo admite el índice de base de datos 0"
    elif (
        not isinstance(nombre_base, str)
        or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", nombre_base)
    ):
        return None, "El nombre debe comenzar con una letra minúscula y contener solo letras, números o guion bajo"
    return (identificador.lower(), nombre_confirmado, motor, nombre_base), None


def escribir_secreto(ruta, contenido, modo=0o444):
    """Crea un secreto montable; el directorio privado limita el acceso en el host."""
    descriptor = os.open(ruta, os.O_WRONLY | os.O_CREAT | os.O_EXCL, modo)
    with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
        archivo.write(contenido)
        archivo.write("\n")


def actualizar_secreto(ruta, contenido):
    """Actualiza el archivo montado por Docker sin cambiar el inode del secreto."""
    descriptor = os.open(ruta, os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0))
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o644)
        else:
            os.chmod(ruta, 0o644)
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as archivo:
            archivo.write(contenido)
            archivo.write("\n")
    finally:
        os.close(descriptor)


def ejecutar_creacion_base_datos(solicitud):
    """Crea un motor fijo, privado y persistente unido a la red del proyecto."""
    validada, error = validar_solicitud_base_datos(solicitud)
    if error:
        return {"correcto": False, "mensaje": error}
    identificador, nombre_confirmado, motor, nombre_base = validada
    try:
        ruta_registro = DIRECTORIO_PROYECTOS / ".registro-swatt.json"
        with ruta_registro.open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el registro del proyecto."}
    if not isinstance(registro, list):
        return {"correcto": False, "mensaje": "El registro del proyecto no es válido."}
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ]
    if len(proyectos) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto importado."}
    proyecto = proyectos[0]
    if proyecto.get("nombre") != nombre_confirmado:
        return {"correcto": False, "mensaje": "El nombre de confirmación no coincide."}
    if proyecto.get("estado") != "desplegado":
        return {"correcto": False, "mensaje": "Despliega primero una aplicación administrada para crear su base de datos."}
    if proyecto.get("baseDatos") is not None:
        return {"correcto": False, "mensaje": "Este proyecto ya tiene una base de datos administrada."}
    if sum(1 for elemento in registro if isinstance(elemento, dict) and elemento.get("baseDatos")) >= MAXIMO_BASES_DATOS_ADMINISTRADAS:
        return {"correcto": False, "mensaje": "Se alcanzó el límite de bases de datos administradas en este servidor."}

    perfil_runtime = proyecto.get("runtimePerfil")
    if perfil_runtime not in (None, "php"):
        runtime, error_runtime = validar_runtime_app(proyecto)
    else:
        runtime, error_runtime = validar_runtime_php(proyecto)
    if error_runtime or runtime["datos"]["State"]["Running"] is not True:
        return {"correcto": False, "mensaje": error_runtime or "La aplicación debe estar activa para conectar una base de datos."}
    if not runtime_monta_secreto_conexion(runtime):
        return {
            "correcto": False,
            "mensaje": "Este runtime se creó antes del soporte de secretos de conexión y debe recrearse antes de asociar una base.",
        }

    perfil = MOTORES_BASES_DATOS[motor]
    sufijo = identificador.replace("-", "")[:12]
    nombre_contenedor = f"swatt-db-{sufijo}"
    nombre_volumen = f"swatt-dbdata-{sufijo}"
    nombre_red = runtime["red"]
    if ejecutar(["docker", "inspect", "--format", "{{.Id}}", nombre_contenedor]) is not None:
        return {"correcto": False, "mensaje": "Ya existe un servicio de base de datos con el identificador reservado."}
    if ejecutar(["docker", "image", "inspect", "--format", "{{.Id}}", perfil["imagen"]]) is None:
        try:
            descarga = subprocess.run(
                ["docker", "pull", perfil["imagen"]],
                check=False,
                capture_output=True,
                text=True,
                timeout=180,
            )
        except subprocess.TimeoutExpired:
            return {"correcto": False, "mensaje": "La descarga de la imagen de base de datos superó el tiempo límite."}
        if descarga.returncode != 0:
            logging.warning("No se pudo descargar la imagen fija %s.", perfil["imagen"])
            return {"correcto": False, "mensaje": "No se pudo descargar la imagen de base de datos necesaria."}

    etiqueta_red = ejecutar([
        "docker", "network", "inspect", "--format",
        '{{index .Labels "com.swatt.project-id"}}', nombre_red,
    ])
    if etiqueta_red != identificador:
        return {"correcto": False, "mensaje": "La red privada del proyecto no supera la validación de etiquetas."}

    inspeccion_volumen = ejecutar([
        "docker", "volume", "inspect", "--format", "{{json .}}", nombre_volumen,
    ])
    if inspeccion_volumen is not None:
        return {"correcto": False, "mensaje": "Ya existe un volumen con el nombre reservado; no se reutilizará ni eliminará automáticamente."}

    marca_creacion = secrets.token_hex(16)
    volumen_creado = False
    try:
        crear_volumen = subprocess.run(
            [
                "docker", "volume", "create",
                "--label", "com.swatt.managed=database",
                "--label", f"com.swatt.project-id={identificador}",
                "--label", f"com.swatt.database.engine={motor}",
                "--label", f"com.swatt.creation-id={marca_creacion}",
                nombre_volumen,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {"correcto": False, "mensaje": "La creación del almacenamiento persistente superó el tiempo límite."}
    if crear_volumen.returncode != 0:
        return {"correcto": False, "mensaje": "No se pudo crear el almacenamiento persistente de la base de datos."}
    volumen_creado = True
    try:
        inspeccion_volumen = ejecutar([
            "docker", "volume", "inspect", "--format", "{{json .}}", nombre_volumen,
        ])
        datos_volumen = json.loads(inspeccion_volumen) if inspeccion_volumen else {}
        etiquetas_volumen = datos_volumen.get("Labels", {})
        if (
            etiquetas_volumen.get("com.swatt.project-id") != identificador
            or etiquetas_volumen.get("com.swatt.database.engine") != motor
            or etiquetas_volumen.get("com.swatt.managed") != "database"
        ):
            return {"correcto": False, "mensaje": "El volumen recién creado no supera la validación de etiquetas."}
        volumen_creado = etiquetas_volumen.get("com.swatt.creation-id") == marca_creacion
        if not volumen_creado:
            return {"correcto": False, "mensaje": "Docker no confirmó que el volumen recién creado pertenezca a esta operación."}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el volumen recién creado."}

    directorio_secreto = None
    directorio_creado = False
    contenedor_iniciado = False
    registro_guardado = False
    secreto_url_actualizado = False
    try:
        DIRECTORIO_SECRETOS.mkdir(mode=0o700, parents=True, exist_ok=True)
        if DIRECTORIO_SECRETOS.is_symlink():
            return {"correcto": False, "mensaje": "El directorio protegido de secretos no es válido."}
        os.chmod(DIRECTORIO_SECRETOS, 0o700)
        directorio_secreto = DIRECTORIO_SECRETOS / identificador
        directorio_secreto.mkdir(mode=0o700, exist_ok=True)
        directorio_creado = True
        if directorio_secreto.is_symlink() or not directorio_secreto.is_dir():
            return {"correcto": False, "mensaje": "El directorio de secretos del proyecto no es válido."}
        directorio_creado = not any(directorio_secreto.iterdir())
        os.chmod(directorio_secreto, 0o700)
        secreto = secrets.token_hex(32)
        ruta_clave = directorio_secreto / "clave"
        escribir_secreto(ruta_clave, secreto)
        esquema = {
            "postgresql": "postgresql",
            "mariadb": "mysql",
            "mongodb": "mongodb",
            "redis": "redis",
        }[motor]
        uri = {
            "postgresql": f"{esquema}://swatt:{secreto}@base-datos:{perfil['puerto']}/{nombre_base}",
            "mariadb": f"{esquema}://swatt:{secreto}@base-datos:{perfil['puerto']}/{nombre_base}",
            "mongodb": f"{esquema}://swatt:{secreto}@base-datos:{perfil['puerto']}/{nombre_base}?authSource={nombre_base}",
            "redis": f"{esquema}://swatt:{secreto}@base-datos:{perfil['puerto']}/0",
        }[motor]
        ruta_url = directorio_secreto / "database-url"
        if ruta_url.is_symlink() or (ruta_url.exists() and not ruta_url.is_file()):
            return {"correcto": False, "mensaje": "El archivo de conexión del proyecto no es válido."}
        if not ruta_url.exists():
            escribir_secreto(ruta_url, "", modo=0o644)
        argumentos = [
            "docker", "run", "--detach",
            "--name", nombre_contenedor,
            "--label", "com.swatt.managed=database",
            "--label", f"com.swatt.project-id={identificador}",
            "--label", f"com.swatt.database.engine={motor}",
            "--restart", "unless-stopped",
            "--network", nombre_red,
            "--network-alias", "base-datos",
            "--mount", f"type=volume,source={nombre_volumen},target={perfil['ruta_datos']}",
            "--mount", f"type=bind,source={ruta_clave},target=/run/secrets/swatt_db_password,readonly",
            "--memory", "512m",
            "--cpus", "0.35",
            "--pids-limit", "128",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
        ]
        if motor != "redis":
            argumentos.extend([
                "--env", f"{perfil['variable_usuario']}={perfil['nombre_usuario']}",
                "--env", f"{perfil['variable_base']}={nombre_base}",
            ])
        if motor == "postgresql":
            secreto_root = secrets.token_hex(32)
            ruta_clave_root = directorio_secreto / "clave-root"
            ruta_usuario = directorio_secreto / "10-swatt-user.sql"
            escribir_secreto(ruta_clave_root, secreto_root)
            escribir_secreto(
                ruta_usuario,
                (
                    f"CREATE ROLE swatt LOGIN PASSWORD '{secreto}';\n"
                    f'ALTER DATABASE "{nombre_base}" OWNER TO swatt;\n'
                    f'GRANT CONNECT ON DATABASE "{nombre_base}" TO swatt;\n'
                ),
            )
            argumentos.extend([
                "--mount",
                f"type=bind,source={ruta_clave_root},target=/run/secrets/swatt_db_root_password,readonly",
                "--mount",
                f"type=bind,source={ruta_usuario},target=/docker-entrypoint-initdb.d/10-swatt-user.sql,readonly",
                "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/swatt_db_root_password",
            ])
        elif motor == "mariadb":
            secreto_root = secrets.token_hex(32)
            ruta_clave_root = directorio_secreto / "clave-root"
            escribir_secreto(ruta_clave_root, secreto_root)
            argumentos.extend([
                "--mount",
                f"type=bind,source={ruta_clave_root},target=/run/secrets/swatt_db_root_password,readonly",
                "--env", "MARIADB_PASSWORD_FILE=/run/secrets/swatt_db_password",
                "--env", "MARIADB_ROOT_PASSWORD_FILE=/run/secrets/swatt_db_root_password",
            ])
        elif motor == "mongodb":
            secreto_root = secrets.token_hex(32)
            ruta_clave_root = directorio_secreto / "clave-root"
            ruta_usuario = directorio_secreto / "10-swatt-user.js"
            escribir_secreto(ruta_clave_root, secreto_root)
            escribir_secreto(
                ruta_usuario,
                (
                    f'db.getSiblingDB("{nombre_base}").createUser({{'
                    f'user: "swatt", pwd: "{secreto}", '
                    f'roles: [{{role: "readWrite", db: "{nombre_base}"}}]}});'
                ),
            )
            argumentos.extend([
                "--mount",
                f"type=bind,source={ruta_clave_root},target=/run/secrets/swatt_db_root_password,readonly",
                "--mount",
                f"type=bind,source={ruta_usuario},target=/docker-entrypoint-initdb.d/10-swatt-user.js,readonly",
                "--env", "MONGO_INITDB_ROOT_PASSWORD_FILE=/run/secrets/swatt_db_root_password",
            ])
        elif motor == "redis":
            ruta_configuracion = directorio_secreto / "redis.conf"
            escribir_secreto(
                ruta_configuracion,
                (
                    "appendonly yes\n"
                    "user default off\n"
                    f"user swatt on >{secreto} ~* &* +@read +@write +@connection +@transaction +@pubsub\n"
                ),
            )
            argumentos.extend([
                "--mount",
                f"type=bind,source={ruta_configuracion},target=/etc/redis/swatt.conf,readonly",
            ])
        else:
            argumentos.extend([
                "--env", f"{perfil['variable_clave']}=/run/secrets/swatt_db_password",
            ])
        argumentos.append(perfil["imagen"])
        if motor == "redis":
            argumentos.append("redis-server")
            argumentos.append("/etc/redis/swatt.conf")

        try:
            resultado = subprocess.run(
                argumentos,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            return {"correcto": False, "mensaje": "La creación de la base de datos superó el tiempo límite."}
        if resultado.returncode != 0:
            logging.warning("Docker rechazó la creación de la base de datos para %s.", identificador[:12])
            return {"correcto": False, "mensaje": "Docker no pudo iniciar el servicio de base de datos aislado."}
        contenedor_iniciado = True

        estado = ejecutar(["docker", "inspect", "--format", "{{.State.Running}}", nombre_contenedor])
        if estado != "true":
            return {"correcto": False, "mensaje": "El contenedor de base de datos no confirmó su estado activo."}
        actualizar_secreto(ruta_url, uri)
        secreto_url_actualizado = True
        inspeccion_volumen = ejecutar([
            "docker", "volume", "inspect", "--format", "{{json .}}", nombre_volumen,
        ])
        try:
            ruta_datos = json.loads(inspeccion_volumen)["Mountpoint"]
        except (TypeError, KeyError, json.JSONDecodeError):
            return {"correcto": False, "mensaje": "No se pudo determinar la ruta persistente de la base de datos."}
        if not isinstance(ruta_datos, str) or not ruta_datos.startswith("/") or len(ruta_datos) > 512:
            return {"correcto": False, "mensaje": "Docker devolvió una ruta persistente de base de datos inválida."}
        base_datos = {
            "motor": motor,
            "contenedor": nombre_contenedor,
            "volumen": nombre_volumen,
            "nombre": nombre_base,
            "usuario": perfil["usuario_aplicacion"],
            "puerto": perfil["puerto"],
            "rutaDatos": ruta_datos,
        }
        proyecto["baseDatos"] = base_datos
        try:
            guardar_registro_proyectos(registro)
        except OSError:
            logging.exception("No se pudo guardar la base de datos para el proyecto %s.", identificador[:12])
            return {"correcto": False, "mensaje": "No se pudo registrar la base de datos; se retiró el contenedor."}
        registro_guardado = True
        logging.info("Base de datos %s creada para el proyecto %s.", motor, identificador[:12])
        return {
            "correcto": True,
            "motor": motor,
            "host": "base-datos",
            "puerto": perfil["puerto"],
            "nombre": nombre_base,
            "usuario": perfil["usuario_aplicacion"],
            "contrasena": secreto,
            "rutaDatos": ruta_datos,
        }
    except FileExistsError:
        return {"correcto": False, "mensaje": "Ya existe un directorio de secretos para este proyecto."}
    except OSError:
        logging.exception("No se pudo proteger la credencial de base de datos para %s.", identificador[:12])
        return {"correcto": False, "mensaje": "No se pudo guardar de forma segura la credencial de la base de datos."}
    finally:
        if not registro_guardado:
            if contenedor_iniciado:
                try:
                    subprocess.run(
                        ["docker", "rm", "--force", nombre_contenedor],
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    logging.exception("No se pudo retirar el contenedor de base de datos incompleto %s.", identificador[:12])
            if directorio_creado and directorio_secreto:
                try:
                    for archivo in directorio_secreto.iterdir():
                        if archivo.is_file() and not archivo.is_symlink():
                            os.chmod(archivo, 0o600)
                    shutil.rmtree(directorio_secreto)
                except OSError:
                    logging.exception("No se pudieron retirar secretos de una creación incompleta %s.", identificador[:12])
            elif secreto_url_actualizado and directorio_secreto:
                try:
                    actualizar_secreto(directorio_secreto / "database-url", "")
                except OSError:
                    logging.exception("No se pudo revertir el archivo de conexión incompleto %s.", identificador[:12])
            if volumen_creado:
                try:
                    subprocess.run(
                        ["docker", "volume", "rm", nombre_volumen],
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    logging.exception("No se pudo retirar el volumen de una creación incompleta %s.", identificador[:12])


def consultar_credenciales_base_datos(solicitud):
    """Revela una credencial solo tras confirmar proyecto y servicio administrado."""
    solicitud_validar = {**solicitud, "accion": "crear_base_datos"} if isinstance(solicitud, dict) else solicitud
    validada, error = validar_solicitud_base_datos(solicitud_validar)
    if error:
        return {"correcto": False, "mensaje": error}
    identificador, nombre_confirmado, motor, nombre_base = validada
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el registro del proyecto."}
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ] if isinstance(registro, list) else []
    if len(proyectos) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto importado."}
    proyecto = proyectos[0]
    base_datos = proyecto.get("baseDatos")
    perfil = MOTORES_BASES_DATOS[motor]
    sufijo = identificador.replace("-", "")[:12]
    if (
        proyecto.get("nombre") != nombre_confirmado
        or not isinstance(base_datos, dict)
        or base_datos.get("motor") != motor
        or base_datos.get("contenedor") != f"swatt-db-{sufijo}"
        or base_datos.get("volumen") != f"swatt-dbdata-{sufijo}"
        or base_datos.get("nombre") != nombre_base
        or base_datos.get("usuario") != perfil["usuario_aplicacion"]
        or base_datos.get("puerto") != perfil["puerto"]
    ):
        return {"correcto": False, "mensaje": "No coincide la base de datos administrada para este proyecto."}

    inspeccion = ejecutar([
        "docker", "inspect", "--format", "{{json .}}", base_datos["contenedor"],
    ])
    if inspeccion is None:
        return {"correcto": False, "mensaje": "El servicio de base de datos ya no existe en Docker."}
    try:
        datos = json.loads(inspeccion)
        configuracion = datos["Config"]
        etiquetas = configuracion["Labels"]
        montajes = datos["Mounts"]
        volumen_correcto = any(
            montaje.get("Type") == "volume"
            and montaje.get("Name") == base_datos["volumen"]
            and montaje.get("Destination") == perfil["ruta_datos"]
            for montaje in montajes
            if isinstance(montaje, dict)
        )
        if (
            configuracion.get("Image") != perfil["imagen"]
            or etiquetas.get("com.swatt.managed") != "database"
            or etiquetas.get("com.swatt.project-id") != identificador
            or etiquetas.get("com.swatt.database.engine") != motor
            or not volumen_correcto
        ):
            return {"correcto": False, "mensaje": "El servicio o el volumen no superan la validación de identidad."}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar la identidad del servicio de base de datos."}
    etiqueta_volumen = ejecutar([
        "docker", "volume", "inspect", "--format",
        '{{index .Labels "com.swatt.project-id"}}', base_datos["volumen"],
    ])
    motor_volumen = ejecutar([
        "docker", "volume", "inspect", "--format",
        '{{index .Labels "com.swatt.database.engine"}}', base_datos["volumen"],
    ])
    if etiqueta_volumen != identificador or motor_volumen != motor:
        return {"correcto": False, "mensaje": "El volumen no coincide con el proyecto y motor registrados."}
    ruta_datos = ejecutar([
        "docker", "volume", "inspect", "--format", "{{.Mountpoint}}",
        base_datos["volumen"],
    ])
    if not isinstance(ruta_datos, str) or not ruta_datos.startswith("/") or len(ruta_datos) > 512:
        return {"correcto": False, "mensaje": "No se pudo determinar la ruta persistente de la base de datos."}

    directorio_secreto = DIRECTORIO_SECRETOS / identificador
    ruta_clave = directorio_secreto / "clave"
    if directorio_secreto.is_symlink() or ruta_clave.is_symlink():
        return {"correcto": False, "mensaje": "La ruta de la credencial protegida no es válida."}
    try:
        contrasena = ruta_clave.read_text(encoding="utf-8").strip()
    except OSError:
        return {"correcto": False, "mensaje": "No se pudo leer la credencial protegida del servicio."}
    if not re.fullmatch(r"[a-f0-9]{64}", contrasena):
        logging.error("La credencial protegida de la base %s tiene un formato inválido.", identificador[:12])
        return {"correcto": False, "mensaje": "La credencial protegida no tiene un formato válido."}
    return {
        "correcto": True,
        "motor": motor,
        "host": "base-datos",
        "puerto": perfil["puerto"],
        "nombre": base_datos["nombre"],
        "usuario": perfil["usuario_aplicacion"],
        "contrasena": contrasena,
        "rutaDatos": ruta_datos,
    }


def validar_solicitud_consola(solicitud):
    """Limita la consola a un proyecto conocido y comandos acotados."""
    if not isinstance(solicitud, dict) or solicitud.get("accion") != "consola_proyecto":
        return None, "acción de consola no permitida"
    identificador = solicitud.get("id")
    nombre = solicitud.get("nombreConfirmado")
    comando = solicitud.get("comando")
    directorio = solicitud.get("directorio", ".")
    if not isinstance(identificador, str) or not re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
        identificador,
        re.IGNORECASE,
    ):
        return None, "identificador de proyecto inválido"
    if not isinstance(nombre, str) or not 2 <= len(nombre) <= 60:
        return None, "nombre de proyecto inválido"
    if (
        not isinstance(comando, str)
        or not comando.strip()
        or len(comando) > 2048
        or "\x00" in comando
    ):
        return None, "el comando está vacío o supera el límite permitido"
    if (
        not isinstance(directorio, str)
        or len(directorio) > 512
        or directorio.startswith("/")
        or "\x00" in directorio
    ):
        return None, "la ruta debe permanecer dentro del proyecto"
    ruta_normalizada = posixpath.normpath(posixpath.join(".", directorio))
    if ruta_normalizada == ".." or ruta_normalizada.startswith("../"):
        return None, "la ruta debe permanecer dentro del proyecto"
    return (identificador.lower(), nombre, comando, ruta_normalizada), None


def ejecutar_consola_proyecto(solicitud):
    """Ejecuta un comando en un toolbox efímero, sin red ni acceso al host."""
    validada, error = validar_solicitud_consola(solicitud)
    if error:
        return {"correcto": False, "mensaje": error}
    identificador, nombre_confirmado, comando, directorio = validada
    ruta_registro = DIRECTORIO_PROYECTOS / ".registro-swatt.json"
    try:
        with ruta_registro.open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el registro del proyecto."}
    if not isinstance(registro, list):
        return {"correcto": False, "mensaje": "El registro del proyecto no es válido."}
    coincidencias = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ]
    if len(coincidencias) != 1 or coincidencias[0].get("nombre") != nombre_confirmado:
        return {"correcto": False, "mensaje": "No se encontró el proyecto confirmado."}

    raiz = DIRECTORIO_PROYECTOS / identificador
    if raiz.is_symlink() or not raiz.is_dir():
        return {"correcto": False, "mensaje": "La carpeta del proyecto no está disponible."}
    ruta_trabajo = raiz.joinpath(*pathlib.PurePosixPath(directorio).parts)
    try:
        ruta_trabajo.resolve(strict=True).relative_to(raiz.resolve(strict=True))
        if not ruta_trabajo.is_dir() or ruta_trabajo.is_symlink():
            return {"correcto": False, "mensaje": "La carpeta de trabajo no está disponible."}
    except (OSError, ValueError):
        return {"correcto": False, "mensaje": "La carpeta de trabajo debe permanecer dentro del proyecto."}

    nombre_contenedor = f"swatt-consola-{secrets.token_hex(8)}"
    directorio_contenedor = "/workspace" if directorio == "." else f"/workspace/{directorio}"
    uid = os.getuid() if hasattr(os, "getuid") else 1000
    gid = os.getgid() if hasattr(os, "getgid") else 1000
    envoltura = (
        'timeout --signal=TERM 12s sh -lc "$1" > /tmp/swatt-console-output 2>&1; '
        'codigo=$?; head -c 6000 /tmp/swatt-console-output; '
        'rm -f /tmp/swatt-console-output; exit "$codigo"'
    )
    argumentos = [
        "docker", "run", "--rm", "--pull=missing",
        "--name", nombre_contenedor,
        "--network", "none",
        "--memory", "192m",
        "--cpus", "0.50",
        "--pids-limit", "48",
        "--read-only",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
        "--user", f"{uid}:{gid}",
        "--workdir", directorio_contenedor,
        "--mount", f"type=bind,source={raiz},target=/workspace",
        "node:22-bookworm-slim",
        "sh", "-lc", envoltura, "swatt-console", comando,
    ]
    try:
        resultado = subprocess.run(
            argumentos,
            check=False,
            capture_output=True,
            text=True,
            timeout=18,
        )
    except subprocess.TimeoutExpired:
        try:
            subprocess.run(
                ["docker", "rm", "--force", nombre_contenedor],
                check=False,
                capture_output=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            logging.exception("No se pudo retirar la consola que superó el tiempo límite.")
        return {
            "correcto": True,
            "salida": "El comando superó el límite de 12 segundos.",
            "codigoSalida": 124,
            "directorio": directorio,
            "limiteTiempo": True,
            "salidaRecortada": False,
        }
    except OSError:
        logging.exception("No se pudo iniciar la consola aislada para %s.", identificador[:12])
        return {"correcto": False, "mensaje": "No se pudo iniciar la consola aislada."}

    salida = resultado.stdout[-6000:]
    if resultado.stderr:
        salida = (salida + resultado.stderr)[-6000:]
    if resultado.returncode != 0 and not salida:
        salida = "El comando terminó con un error. Comprueba la ruta y vuelve a intentarlo."
    return {
        "correcto": True,
        "salida": salida,
        "codigoSalida": resultado.returncode,
        "directorio": directorio,
        "limiteTiempo": resultado.returncode == 124,
        "salidaRecortada": len(resultado.stdout) + len(resultado.stderr) > 6000,
    }


def validar_solicitud_terminal(solicitud):
    """Valida proyecto, carpeta y dimensiones de una sesión PTY."""
    if not isinstance(solicitud, dict) or solicitud.get("accion") != "terminal_proyecto":
        return None, "acción de terminal no permitida"
    identificador = solicitud.get("id")
    nombre = solicitud.get("nombreConfirmado")
    directorio = solicitud.get("directorio", ".")
    columnas = solicitud.get("columnas", 100)
    filas = solicitud.get("filas", 30)
    if not isinstance(identificador, str) or not re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
        identificador,
        re.IGNORECASE,
    ):
        return None, "identificador de proyecto inválido"
    if not isinstance(nombre, str) or not 2 <= len(nombre) <= 60:
        return None, "nombre de proyecto inválido"
    if (
        not isinstance(directorio, str)
        or len(directorio) > 512
        or directorio.startswith("/")
        or "\x00" in directorio
    ):
        return None, "la carpeta debe permanecer dentro del proyecto"
    ruta_normalizada = posixpath.normpath(posixpath.join(".", directorio))
    if ruta_normalizada == ".." or ruta_normalizada.startswith("../"):
        return None, "la carpeta debe permanecer dentro del proyecto"
    if type(columnas) is not int or not 20 <= columnas <= 300:
        return None, "el ancho de terminal no es válido"
    if type(filas) is not int or not 5 <= filas <= 100:
        return None, "el alto de terminal no es válido"
    return (identificador.lower(), nombre, ruta_normalizada, columnas, filas), None


def asegurar_imagen_terminal():
    """Construye una imagen fija con Bash y herramientas de desarrollo habituales."""
    with cerradura_imagen_terminal:
        if ejecutar(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGEN_TERMINAL]):
            return True, None
        try:
            with tempfile.TemporaryDirectory(prefix="swatt-terminal-build-") as contexto:
                dockerfile = pathlib.Path(contexto) / "Dockerfile"
                dockerfile.write_text(DOCKERFILE_TERMINAL, encoding="utf-8")
                resultado = subprocess.run(
                    ["docker", "build", "--pull", "--tag", IMAGEN_TERMINAL, "--file", str(dockerfile), contexto],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
        except subprocess.TimeoutExpired:
            return False, "La preparación de la imagen de terminal superó el tiempo límite."
        except OSError:
            logging.exception("No se pudo iniciar la construcción de la imagen de terminal.")
            return False, "No se pudo preparar la imagen de terminal."
        if resultado.returncode != 0:
            logging.error("No se pudo construir la imagen de terminal: %s", resultado.stderr[-2000:])
            return False, "No se pudieron instalar las herramientas de la terminal."
        return True, None


def recibir_bytes_terminal(conexion, cantidad):
    """Lee un marco completo enviado por el proxy WebSocket."""
    partes = []
    restante = cantidad
    while restante:
        parte = conexion.recv(restante)
        if not parte:
            return None
        partes.append(parte)
        restante -= len(parte)
    return b"".join(partes)


def atender_terminal_proyecto(conexion, solicitud):
    """Mantiene un Bash interactivo PTY conectado al proyecto autorizado."""
    def responder_error(mensaje):
        conexion.sendall(
            json.dumps({"correcto": False, "mensaje": mensaje}, ensure_ascii=False).encode("utf-8") + b"\n"
        )

    if os.name != "posix":
        responder_error("La terminal solo esta disponible en Linux.")
        return
    import fcntl
    import pty
    import termios

    validada, error = validar_solicitud_terminal(solicitud)
    if error:
        responder_error(error)
        return
    identificador, nombre, directorio, columnas, filas = validada
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        responder_error("No se pudo validar el registro del proyecto.")
        return
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ] if isinstance(registro, list) else []
    if (
        len(proyectos) != 1
        or proyectos[0].get("nombre") != nombre
        or proyectos[0].get("estado") == "archivado"
    ):
        responder_error("No se encontro el proyecto confirmado.")
        return
    raiz = DIRECTORIO_PROYECTOS / identificador
    try:
        raiz_real = raiz.resolve(strict=True)
        ruta_trabajo = raiz_real.joinpath(*pathlib.PurePosixPath(directorio).parts)
        ruta_real = ruta_trabajo.resolve(strict=True)
        ruta_real.relative_to(raiz_real)
        if raiz.is_symlink() or ruta_trabajo.is_symlink() or not ruta_real.is_dir():
            raise ValueError("carpeta insegura")
    except (OSError, ValueError):
        responder_error("La carpeta debe ser una carpeta valida dentro del proyecto.")
        return
    if not sesiones_terminales.acquire(blocking=False):
        responder_error("Se alcanzo el limite de terminales simultaneas.")
        return

    contenedor = f"swatt-terminal-{secrets.token_hex(8)}"
    uid = os.getuid()
    gid = os.getgid()
    correcto, error_imagen = asegurar_imagen_terminal()
    if not correcto:
        sesiones_terminales.release()
        responder_error(error_imagen)
        return

    maestro = None
    esclavo = None
    proceso = None
    try:
        maestro, esclavo = pty.openpty()
        fcntl.ioctl(esclavo, termios.TIOCSWINSZ, struct.pack("HHHH", filas, columnas, 0, 0))
        directorio_contenedor = "/workspace" if directorio == "." else f"/workspace/{directorio}"
        argumentos = [
            "docker", "run", "--rm", "--interactive", "--tty",
            "--name", contenedor,
            "--network", "bridge",
            "--memory", "512m",
            "--cpus", "0.75",
            "--pids-limit", "64",
            "--read-only",
            "--security-opt", "no-new-privileges",
            "--cap-drop", "ALL",
            "--tmpfs", "/tmp:rw,nosuid,size=128m",
            "--user", f"{uid}:{gid}",
            "--env", "HOME=/tmp",
            "--env", "TERM=xterm-256color",
            "--workdir", directorio_contenedor,
            "--mount", f"type=bind,source={raiz_real},target=/workspace",
            IMAGEN_TERMINAL,
            "bash", "--noprofile", "--norc", "-i",
        ]
        proceso = subprocess.Popen(
            argumentos,
            stdin=esclavo,
            stdout=esclavo,
            stderr=esclavo,
            close_fds=True,
            start_new_session=True,
        )
        os.close(esclavo)
        esclavo = None
        conexion.sendall(json.dumps({
            "correcto": True,
            "directorio": directorio,
            "nombre": nombre,
        }).encode("utf-8") + b"\n")

        while proceso.poll() is None:
            disponibles, _, _ = select.select([conexion, maestro], [], [], 0.5)
            if conexion in disponibles:
                encabezado = recibir_bytes_terminal(conexion, 5)
                if encabezado is None:
                    break
                tipo, longitud = struct.unpack("!BI", encabezado)
                if longitud > 65536:
                    break
                carga = recibir_bytes_terminal(conexion, longitud)
                if carga is None:
                    break
                if tipo == 1:
                    os.write(maestro, carga)
                elif tipo == 2 and longitud == 4:
                    nuevas_columnas, nuevas_filas = struct.unpack("!HH", carga)
                    if 20 <= nuevas_columnas <= 300 and 5 <= nuevas_filas <= 100:
                        fcntl.ioctl(
                            maestro,
                            termios.TIOCSWINSZ,
                            struct.pack("HHHH", nuevas_filas, nuevas_columnas, 0, 0),
                        )
                else:
                    break
            if maestro in disponibles:
                try:
                    salida = os.read(maestro, 16384)
                except OSError:
                    break
                if not salida:
                    break
                conexion.sendall(salida)
    except (OSError, ValueError, struct.error):
        logging.exception("La sesión de terminal para el proyecto %s terminó con error.", identificador[:12])
    finally:
        if esclavo is not None:
            os.close(esclavo)
        if maestro is not None:
            try:
                os.write(maestro, b"\x03")
            except OSError:
                pass
            os.close(maestro)
        if proceso is not None:
            if proceso.poll() is None:
                proceso.terminate()
                try:
                    proceso.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proceso.kill()
                    proceso.wait(timeout=5)
            try:
                subprocess.run(
                    ["docker", "rm", "--force", contenedor],
                    check=False,
                    capture_output=True,
                    timeout=10,
                )
            except (OSError, subprocess.TimeoutExpired):
                logging.exception("No se pudo retirar el contenedor de terminal %s.", contenedor)
        sesiones_terminales.release()


def eliminar_base_datos_archivada(solicitud):
    """Borra el servicio y volumen solo tras validar etiquetas del proyecto y del motor."""
    solicitud_validar = {**solicitud, "accion": "crear_base_datos"} if isinstance(solicitud, dict) else solicitud
    validada, error = validar_solicitud_base_datos(solicitud_validar)
    if error:
        return {"correcto": False, "mensaje": error}
    identificador, nombre_confirmado, motor, nombre_base = validada
    try:
        with (DIRECTORIO_PROYECTOS / ".registro-swatt.json").open(encoding="utf-8") as archivo:
            registro = json.load(archivo)
    except (OSError, json.JSONDecodeError):
        return {"correcto": False, "mensaje": "No se pudo validar el registro del proyecto."}
    proyectos = [
        proyecto for proyecto in registro
        if isinstance(proyecto, dict) and proyecto.get("id") == identificador
    ] if isinstance(registro, list) else []
    if len(proyectos) != 1:
        return {"correcto": False, "mensaje": "No se encontró el proyecto archivado."}
    proyecto = proyectos[0]
    base_datos = proyecto.get("baseDatos")
    perfil = MOTORES_BASES_DATOS[motor]
    sufijo = identificador.replace("-", "")[:12]
    nombre_contenedor = f"swatt-db-{sufijo}"
    nombre_volumen = f"swatt-dbdata-{sufijo}"
    if (
        proyecto.get("nombre") != nombre_confirmado
        or proyecto.get("estado") != "archivado"
        or not isinstance(base_datos, dict)
        or base_datos.get("motor") != motor
        or base_datos.get("contenedor") != nombre_contenedor
        or base_datos.get("volumen") != nombre_volumen
        or base_datos.get("nombre") != nombre_base
        or base_datos.get("usuario") != perfil["usuario_aplicacion"]
        or base_datos.get("puerto") != perfil["puerto"]
    ):
        return {"correcto": False, "mensaje": "Solo se puede borrar una base archivada y validada."}

    directorio_secreto = DIRECTORIO_SECRETOS / identificador
    if DIRECTORIO_SECRETOS.is_symlink() or directorio_secreto.is_symlink():
        return {"correcto": False, "mensaje": "La ruta de secretos no es segura; no se eliminó la base."}
    if directorio_secreto.exists() and not directorio_secreto.is_dir():
        return {"correcto": False, "mensaje": "La ruta de secretos no es un directorio seguro."}

    inspeccion_volumen = ejecutar([
        "docker", "volume", "inspect", "--format", "{{json .}}", nombre_volumen,
    ])
    if inspeccion_volumen is not None:
        try:
            datos_volumen = json.loads(inspeccion_volumen)
            etiquetas_volumen = datos_volumen["Labels"]
            if (
                datos_volumen.get("Name") != nombre_volumen
                or etiquetas_volumen.get("com.swatt.managed") != "database"
                or etiquetas_volumen.get("com.swatt.project-id") != identificador
                or etiquetas_volumen.get("com.swatt.database.engine") != motor
            ):
                return {"correcto": False, "mensaje": "El volumen no coincide con la base administrada; no se eliminó."}
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return {"correcto": False, "mensaje": "No se pudo validar el volumen; no se eliminó."}

    inspeccion_contenedor = ejecutar([
        "docker", "inspect", "--format", "{{json .}}", nombre_contenedor,
    ])
    if inspeccion_contenedor is not None:
        try:
            datos_contenedor = json.loads(inspeccion_contenedor)
            etiquetas = datos_contenedor["Config"]["Labels"]
            montajes = datos_contenedor["Mounts"]
            volumen_correcto = any(
                montaje.get("Type") == "volume"
                and montaje.get("Name") == nombre_volumen
                and montaje.get("Destination") == perfil["ruta_datos"]
                for montaje in montajes
                if isinstance(montaje, dict)
            )
            if (
                datos_contenedor.get("Name") != f"/{nombre_contenedor}"
                or datos_contenedor["Config"].get("Image") != perfil["imagen"]
                or etiquetas.get("com.swatt.managed") != "database"
                or etiquetas.get("com.swatt.project-id") != identificador
                or etiquetas.get("com.swatt.database.engine") != motor
                or not volumen_correcto
            ):
                return {"correcto": False, "mensaje": "El servicio no coincide con la base administrada; no se eliminó."}
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return {"correcto": False, "mensaje": "No se pudo validar el servicio; no se eliminó."}
        if ejecutar(["docker", "rm", "--force", nombre_contenedor]) is None:
            return {"correcto": False, "mensaje": "No se pudo retirar el servicio de base de datos."}

    if inspeccion_volumen is not None and ejecutar(["docker", "volume", "rm", nombre_volumen]) is None:
        return {"correcto": False, "mensaje": "El volumen no se pudo borrar; revisa si otro contenedor lo utiliza."}

    if directorio_secreto.exists():
        shutil.rmtree(directorio_secreto)
    for prefijo in (NOMBRE_RED_PHP, NOMBRE_RED_APP):
        red = f"{prefijo}{sufijo}"
        inspeccion_red = ejecutar(["docker", "network", "inspect", "--format", "{{json .}}", red])
        try:
            datos_red = json.loads(inspeccion_red) if inspeccion_red else {}
            etiquetas_red = datos_red.get("Labels", {})
            tipo_red = "php-project" if prefijo == NOMBRE_RED_PHP else "application"
            if (
                datos_red.get("Name") != red
                or etiquetas_red.get("com.swatt.project-id") != identificador
                or etiquetas_red.get("com.swatt.managed") != tipo_red
                or datos_red.get("Internal") is not True
            ):
                continue
            if ejecutar(["docker", "network", "rm", red]) is None:
                logging.warning("La base del proyecto %s se eliminó; quedó una red aislada sin poder retirarse.", identificador[:12])
        except (TypeError, ValueError, json.JSONDecodeError):
            logging.warning("No se pudo validar una red asociada a la base archivada %s.", identificador[:12])
    return {"correcto": True, "nombre": nombre_confirmado}


def ejecutar_solicitud_accion(solicitud):
    """Serializa operaciones y distribuye solo a las acciones conocidas."""
    with cerradura_acciones:
        if isinstance(solicitud, dict) and solicitud.get("accion") == "php_estado":
            return consultar_estado_php()
        if isinstance(solicitud, dict) and solicitud.get("accion") in {
            "php_iniciar",
            "php_detener",
            "php_reiniciar",
        }:
            return operar_runtime_php(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "preparar_actualizacion":
            return preparar_actualizacion_proyecto(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "archivar_proyecto":
            return archivar_proyecto(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "desplegar_php":
            return ejecutar_despliegue_php(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "desplegar_app":
            return ejecutar_despliegue_app(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "crear_base_datos":
            return ejecutar_creacion_base_datos(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "credenciales_base_datos":
            return consultar_credenciales_base_datos(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "eliminar_base_datos":
            return eliminar_base_datos_archivada(solicitud)
        if isinstance(solicitud, dict) and solicitud.get("accion") == "consola_proyecto":
            return ejecutar_consola_proyecto(solicitud)
        return ejecutar_accion_docker(solicitud)


class ManejadorAcciones(socketserver.StreamRequestHandler):
    """Atiende una solicitud JSON limitada por conexión al socket local."""

    def handle(self):
        linea = self.rfile.readline(4097)
        if len(linea) > 4096 or not linea.endswith(b"\n"):
            self.wfile.write(b'{"correcto":false,"mensaje":"solicitud demasiado grande"}\n')
            return
        try:
            solicitud = json.loads(linea)
            if isinstance(solicitud, dict) and solicitud.get("accion") == "terminal_proyecto":
                atender_terminal_proyecto(self.connection, solicitud)
                return
            resultado = ejecutar_solicitud_accion(solicitud)
        except (json.JSONDecodeError, UnicodeDecodeError):
            resultado = {"correcto": False, "mensaje": "solicitud JSON inválida"}
        except Exception:
            traceback.print_exc()
            resultado = {"correcto": False, "mensaje": "error interno del agente"}
        self.wfile.write(json.dumps(resultado, ensure_ascii=False).encode("utf-8") + b"\n")


ClaseServidorUnix = getattr(socketserver, "ThreadingUnixStreamServer", socketserver.ThreadingTCPServer)


class ServidorAcciones(ClaseServidorUnix):
    """Servidor de socket privado para acciones Docker estrictamente permitidas."""

    daemon_threads = True
    allow_reuse_address = True


def iniciar_servidor_acciones():
    """Crea el socket con acceso para la cuenta del agente y el grupo Docker."""
    import grp


    ARCHIVO_SOCKET_ACCIONES.unlink(missing_ok=True)
    servidor = ServidorAcciones(str(ARCHIVO_SOCKET_ACCIONES), ManejadorAcciones)
    grupo_docker = grp.getgrnam("docker")
    os.chown(ARCHIVO_SOCKET_ACCIONES, os.getuid(), grupo_docker.gr_gid)
    os.chmod(ARCHIVO_SOCKET_ACCIONES, 0o660)
    servidor.serve_forever()


def leer_seguridad():
    """Consulta el firewall, Fail2ban y SSH sin solicitar privilegios elevados."""
    estado_ufw = ejecutar(["/usr/sbin/ufw", "status", "verbose"])
    if estado_ufw is None:
        estado_ufw = ejecutar(["/sbin/ufw", "status", "verbose"])
    estado_ufw_servicio = ejecutar(["systemctl", "is-active", "ufw"])
    estado_fail2ban = ejecutar(["systemctl", "is-active", "fail2ban"])
    ufw_activo = None
    reglas_ufw = []
    if estado_ufw is not None:
        ufw_activo = "activo" if "Status: active" in estado_ufw else "inactivo"
        dentro_de_reglas = False
        for linea in estado_ufw.splitlines():
            if linea.strip().startswith("--"):
                dentro_de_reglas = True
                continue
            regla = linea.strip()
            if dentro_de_reglas and regla:
                reglas_ufw.append(regla[:160])
    elif estado_ufw_servicio is not None:
        ufw_activo = "activo" if estado_ufw_servicio == "active" else "inactivo"
    fail2ban_activo = None
    if estado_fail2ban is not None:
        fail2ban_activo = "activo" if estado_fail2ban == "active" else "inactivo"
    salida_fail2ban = ejecutar(["/usr/bin/fail2ban-client", "status"]) if fail2ban_activo == "activo" else None
    if salida_fail2ban is None and fail2ban_activo == "activo":
        salida_fail2ban = ejecutar(["fail2ban-client", "status"])
    jails = []
    if salida_fail2ban:
        coincidencia = re.search(r"(?m)^\s*Jail list:\s*(.*?)\s*$", salida_fail2ban)
        if coincidencia:
            jails = [jail.strip()[:64] for jail in coincidencia.group(1).split(",") if jail.strip()][:20]
    estado_ssh = ejecutar(["systemctl", "is-active", "ssh"])
    return {
        "ufw": ufw_activo,
        "ufwReglas": reglas_ufw[:20],
        "fail2ban": fail2ban_activo,
        "fail2banJails": jails,
        "ssh": "activo · puerto 22" if estado_ssh == "active" else (
            "inactivo · puerto 22" if estado_ssh is not None else "estado no disponible · puerto 22"
        ),
    }


def escribir_estado(estado):
    """Reemplaza el archivo de métricas de forma atómica y legible por el panel."""
    DIRECTORIO_ESTADO.mkdir(mode=0o755, parents=True, exist_ok=True)
    descriptor, ruta_temporal = tempfile.mkstemp(dir=DIRECTORIO_ESTADO, prefix=".estado-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
            json.dump(estado, archivo, ensure_ascii=False)
            archivo.write("\n")
        os.chmod(ruta_temporal, 0o644)
        os.replace(ruta_temporal, ARCHIVO_ESTADO)
    finally:
        if os.path.exists(ruta_temporal):
            os.unlink(ruta_temporal)


def construir_estado(cpu_previo):
    """Reúne las métricas reales del host en el esquema que consume el panel."""
    cpu_actual, porcentaje_cpu = calcular_uso_cpu(cpu_previo)
    estado = {
        "momento": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hostname": os.uname().nodename,
        "plataforma": f"{os.uname().sysname} {os.uname().release}",
        "arquitectura": os.uname().machine,
        "cpu": {
            "nucleos": os.cpu_count() or 1,
            "carga": list(os.getloadavg()),
            "porcentaje": porcentaje_cpu,
        },
        "memoria": leer_memoria(),
        "disco": leer_disco(),
        "red": leer_red(),
        "docker": leer_docker(),
        "seguridad": leer_seguridad(),
        "mantenimiento": leer_mantenimiento(),
    }
    return cpu_actual, estado


def main():
    """Actualiza el informe periódicamente y registra fallas en el journal."""
    restaurar_proxies_php()
    estado_php = consultar_estado_php()
    if not estado_php["correcto"]:
        logging.error("No se pudieron sincronizar los runtimes PHP al iniciar: %s", estado_php["mensaje"])
    threading.Thread(target=iniciar_servidor_acciones, daemon=True).start()
    cpu_previo = None
    while True:
        inicio = time.monotonic()
        try:
            cpu_previo, estado = construir_estado(cpu_previo)
            escribir_estado(estado)
        except Exception:
            traceback.print_exc()
        demora = max(0, INTERVALO_SEGUNDOS - (time.monotonic() - inicio))
        time.sleep(demora)


if __name__ == "__main__":
    main()
