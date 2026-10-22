import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

const METODOS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Metodo = (typeof METODOS)[number];

/**
 * Express 4 no captura los rechazos de los handlers asíncronos: si un `await`
 * lanza (un error de Supabase, por ejemplo), la promesa queda rechazada, el
 * cliente se queda colgado y el proceso se cae. Este envoltorio encamina el
 * error al middleware de errores.
 */
function segura(handler: Handler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Envuelve los handlers de un router para que sus errores asíncronos lleguen
 * al middleware de errores en vez de tumbar el proceso.
 */
export function routerSeguro(router: Router): Router {
  const r = router as unknown as Record<Metodo, (path: string, ...h: RequestHandler[]) => Router>;
  for (const metodo of METODOS) {
    const original = r[metodo].bind(router);
    r[metodo] = (path, ...handlers) => original(path, ...handlers.map(segura));
  }
  return router;
}
