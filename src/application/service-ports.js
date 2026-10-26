/**
 * Application services use explicit live ports, never a copied chat snapshot.
 * Factories only declare methods. Resource reads and work start after assembly.
 * Error objects, promises, AbortSignals and storage handles cross unchanged.
 */
export function createServiceScope(contract, services, bindings) {
  const descriptors = {};
  for (const name of contract.reads) {
    const source = Object.getOwnPropertyDescriptor(bindings, name);
    if (!source?.get) throw new TypeError(`Missing live resource port: ${name}`);
    const writable = contract.writes.includes(name);
    if (writable && !source.set) throw new TypeError(`Missing writable resource port: ${name}`);
    descriptors[name] = { enumerable: true, get: source.get, ...(writable ? { set: source.set } : {}) };
  }
  for (const name of contract.requires) {
    if (Object.hasOwn(descriptors, name)) throw new TypeError(`Ambiguous application port: ${name}`);
    // Resolve only when called: mutually coordinating workers can be assembled
    // without starting them, or touching resources still being initialized.
    let resolved;
    descriptors[name] = { enumerable: true, get() {
      if (resolved) return resolved;
      for (const service of Object.values(services)) if (Object.hasOwn(service, name)) return resolved = service[name];
      throw new TypeError(`Unresolved application method: ${name}`);
    } };
  }
  return Object.freeze(Object.defineProperties({}, descriptors));
}

export function composeApplicationServices(definitions, bindings) {
  const services = {}, methods = new Set(), names = new Set();
  for (const { name, contract } of definitions) {
    if (!name || names.has(name)) throw new TypeError(`Duplicate application service: ${name}`);
    names.add(name);
    for (const method of contract.provides) {
      if (methods.has(method)) throw new TypeError(`Duplicate application method: ${method}`);
      methods.add(method);
    }
  }
  for (const { contract } of definitions) for (const method of contract.requires) {
    if (!methods.has(method)) throw new TypeError(`Missing application dependency: ${method}`);
  }
  for (const { name, contract, create } of definitions) {
    const service = create(createServiceScope(contract, services, bindings));
    if (!service || Object.keys(service).length !== contract.provides.length || contract.provides.some(method => typeof service[method] !== 'function')) {
      throw new TypeError(`Invalid application service implementation: ${name}`);
    }
    services[name] = Object.freeze(service);
  }
  return Object.freeze(services);
}
