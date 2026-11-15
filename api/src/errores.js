export class ErrorHttp extends Error {
  constructor(status, cuerpo) {
    super(cuerpo.error);
    this.status = status;
    this.cuerpo = cuerpo;
  }
}

export const peticionInvalida = (campo) => new ErrorHttp(400, { error: 'peticion_invalida', campo });
export const noEncontrado = (recurso) => new ErrorHttp(404, { error: 'no_encontrado', recurso });
