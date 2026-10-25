import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("webaios", {});
