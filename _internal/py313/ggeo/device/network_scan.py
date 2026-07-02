import asyncio
import logging
import re
import socket
import struct
import sys

logger = logging.getLogger("ggeo.network_scan")

LOCKDOWN_PORT = 62078
SCAN_TIMEOUT = 0.3
SEMAPHORE_LIMIT = 50


def detect_subnet() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        return None
    parts = local_ip.rsplit(".", 1)
    if len(parts) != 2:
        return None
    return parts[0]


async def arp_table() -> list[str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "arp", "-a",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        output = stdout.decode(errors="replace")
    except Exception as e:
        logger.debug("arp_table failed: %s", e)
        return []

    ips = []
    if sys.platform == "darwin":
        for m in re.finditer(r"\((\d+\.\d+\.\d+\.\d+)\)", output):
            ips.append(m.group(1))
    else:
        for line in output.splitlines():
            m = re.match(r"\s*(\d+\.\d+\.\d+\.\d+)\s", line)
            if m:
                ips.append(m.group(1))
    return ips


async def scan_lockdown_port(ips: list[str],
                             timeout: float = SCAN_TIMEOUT) -> list[str]:
    sem = asyncio.Semaphore(SEMAPHORE_LIMIT)
    responding = []

    async def _probe(ip: str):
        async with sem:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(ip, LOCKDOWN_PORT),
                    timeout=timeout,
                )
                writer.close()
                await writer.wait_closed()
                responding.append(ip)
            except Exception:
                pass

    await asyncio.gather(*[_probe(ip) for ip in ips])
    return responding


async def identify_device(ip: str, timeout: float = 5.0) -> dict | None:
    try:
        from pymobiledevice3.lockdown import create_using_tcp
        ld = await asyncio.wait_for(
            create_using_tcp(ip, autopair=False), timeout=timeout)
        try:
            product_type = getattr(ld, "product_type", None)
            display_name = getattr(ld, "display_name", None)
            udid = getattr(ld, "udid", None)
            return {
                "product_type": product_type,
                "display_name": display_name,
                "udid": udid,
            }
        finally:
            try:
                await ld.close()
            except Exception:
                pass
    except Exception as e:
        logger.debug("identify_device(%s) failed: %s", ip, e)
        return None


async def find_device_by_subnet(target_udid: str,
                                target_model: str = None) -> dict | None:
    subnet = detect_subnet()
    if not subnet:
        logger.info("Subnet scan: cannot detect local subnet")
        return None

    logger.info("Subnet scan: subnet=%s.0/24, target=%s (model=%s)",
                subnet, target_udid[:12], target_model)

    arp_ips = await arp_table()
    subnet_ips = [ip for ip in arp_ips if ip.startswith(subnet + ".")]
    if not subnet_ips:
        logger.info("Subnet scan: no IPs from ARP table in %s.0/24", subnet)
        return None

    logger.info("Subnet scan: %d ARP entries in subnet, probing port %d",
                len(subnet_ips), LOCKDOWN_PORT)

    ios_ips = await scan_lockdown_port(subnet_ips)
    if not ios_ips:
        logger.info("Subnet scan: no devices responding on port %d", LOCKDOWN_PORT)
        return None

    logger.info("Subnet scan: %d device(s) responding, identifying...", len(ios_ips))

    model_matches = []
    for ip in ios_ips:
        info = await identify_device(ip)
        if not info:
            continue
        if info.get("udid") == target_udid:
            logger.info("Subnet scan: FOUND (udid match) %s @ %s",
                        target_udid[:12], ip)
            return {"ip": ip, "udid": target_udid}
        if target_model and info.get("product_type") == target_model:
            model_matches.append(ip)

    if len(model_matches) == 1:
        logger.info("Subnet scan: FOUND (unique model match %s) %s @ %s",
                    target_model, target_udid[:12], model_matches[0])
        return {"ip": model_matches[0], "udid": target_udid}
    elif model_matches:
        logger.info("Subnet scan: %d devices match model %s, ambiguous",
                    len(model_matches), target_model)

    logger.info("Subnet scan: target %s not found among %d responding device(s)",
                target_udid[:12], len(ios_ips))
    return None
