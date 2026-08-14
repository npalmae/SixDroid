import json
import sys

import uiautomator2 as u2


def selector(device, spec):
    if spec.get("resourceId"):
        return device(resourceId=spec["resourceId"])
    if spec.get("text"):
        return device(text=spec["text"])
    if spec.get("description"):
        return device(description=spec["description"])
    raise ValueError("selector requires resourceId, text, or description")


def main():
    request = json.loads(sys.argv[1])
    device = u2.connect(request["serial"])
    action = request["action"]

    if action == "inspect":
        nodes = []
        for node in device.xpath("//*").all():
            info = node.info
            if not any((info.get("text"), info.get("contentDescription"), info.get("resourceName"))):
                continue
            nodes.append({
                "text": info.get("text") or "",
                "description": info.get("contentDescription") or "",
                "resourceId": info.get("resourceName") or "",
                "className": info.get("className") or "",
                "clickable": bool(info.get("clickable")),
                "enabled": bool(info.get("enabled", True)),
                "bounds": info.get("bounds"),
            })
        return {"ok": True, "nodes": nodes}

    if action == "tap":
        device.click(int(request["x"]), int(request["y"]))
        return {"ok": True, "action": action}
    if action == "swipe":
        device.swipe(
            int(request["x1"]), int(request["y1"]),
            int(request["x2"]), int(request["y2"]),
            float(request.get("duration", 0.3)),
        )
        return {"ok": True, "action": action}
    if action == "press":
        key = request.get("key")
        if key not in ("back", "home", "recent", "enter"):
            raise ValueError("unsupported key")
        device.press(key)
        return {"ok": True, "action": action}

    target = selector(device, request.get("selector") or {})
    if not target.exists(timeout=3):
        raise ValueError("element not found")
    if action == "setText":
        target.set_text(str(request.get("value", "")))
    elif action == "click":
        target.click()
    else:
        raise ValueError("unsupported action")
    return {"ok": True, "action": action}


try:
    print(json.dumps(main(), ensure_ascii=True))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=True))
    sys.exit(1)
