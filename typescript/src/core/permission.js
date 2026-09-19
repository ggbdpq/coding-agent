export function createPermissionGate(io, yoloRef) {
    return async (toolName, preview) => {
        if (yoloRef.value)
            return true;
        const decision = await io.ask({ tool: toolName, preview });
        if (decision === 'always')
            yoloRef.value = true;
        return decision !== 'deny';
    };
}
