import type { Task } from '../shared/types';

export default function TaskGuide({ kind, evaluation, comparing, singleAuthor = false, awaitingSelfReview = false, selfReviewed = false }: { kind: Task['kind']; evaluation: boolean; comparing: boolean; singleAuthor?: boolean; awaitingSelfReview?: boolean; selfReviewed?: boolean }) {
  const title = singleAuthor && awaitingSelfReview ? 'Revisa tu anotación' : singleAuthor && selfReviewed ? 'Revisión personal confirmada' : kind === 'author' ? 'Una tarea, una pregunta'
    : kind === 'review' ? comparing ? 'Compara las anotaciones' : 'Responde de forma independiente'
    : kind === 'adjudicate' ? 'Resuelve el desacuerdo' : 'Evalúa la respuesta anónima';
  const summary = singleAuthor ? selfReviewed ? 'La misma persona creó y revisó esta pregunta. Puede incluirse en una versión congelada.' : awaitingSelfReview ? 'Vuelve a comprobar la pregunta, la respuesta y la evidencia en el documento. Después confirma tu revisión personal.' : 'Crea una pregunta, una respuesta breve y su evidencia. Tras enviarlas, revisa tú mismo la anotación y confirma la revisión.'
    : kind === 'author' ? 'Escribe una pregunta clara sobre el documento, una respuesta breve y la evidencia mínima suficiente.'
    : kind === 'review' ? comparing ? 'Tu versión ya está enviada. Revisa la original y acepta la anotación o explica el desacuerdo.' : 'Responde la pregunta y selecciona tu propia evidencia. Verás la anotación original después de enviar tu versión.'
    : kind === 'adjudicate' ? evaluation ? 'Contrasta ambas valoraciones con el documento y la referencia. Registra tu decisión y su motivo.' : 'Contrasta ambas anotaciones con el documento. Elige o corrige la versión final y explica tu decisión.'
    : 'Comprueba corrección, respaldo, citas y abstención usando el documento y la referencia. El método está oculto.';

  return <section className="task-guide" aria-labelledby="task-guide-title">
    <div className="task-guide-intro"><h2 id="task-guide-title">{title}</h2><p>{summary}</p></div>
    <details><summary>Instrucciones y ejemplo</summary><div className="task-guide-content">
      {!evaluation && <section>
        <h3>{kind === 'author' ? 'Pregunta y respuesta' : kind === 'review' ? 'Revisión independiente' : 'Decisión final'}</h3>
        {kind === 'author' ? <>
          <p>Crea una sola pregunta por tarea. Debe entenderse por sí misma y poder comprobarse con este documento. Escribe una respuesta tan breve como sea posible sin dejar partes de la pregunta sin contestar.</p>
          {singleAuthor && <p>En este proyecto trabajas como único anotador. «Enviar» fija tu autoría; luego debes comprobarla de nuevo con el documento y pulsar «Confirmar revisión». Es una revisión personal, no una revisión independiente.</p>}
          <dl><dt>Dato puntual</dt><dd>Un dato explícito: quién, cuándo, cuánto o qué.</dd><dt>Explicación</dt><dd>Cómo o por qué ocurre algo, según el documento.</dd><dt>Varias secciones</dt><dd>La respuesta necesita combinar información de secciones distintas.</dd></dl>
        </> : kind === 'review' ? <>
          <p>Conserva la pregunta y trabaja primero sólo con el documento, sin consultar la respuesta ni la evidencia de otra persona. Escribe tu respuesta breve y marca los pasajes que la sostienen.</p>
          <p>Tras enviar, acepta si la anotación original es correcta y suficiente, aunque tu redacción o evidencia difieran. Si no lo es, describe el desacuerdo.</p>
        </> : <p>Revisa las dos propuestas y sus fuentes. «Usar esta versión» copia una propuesta: comprueba la respuesta y cada conjunto de evidencia antes de enviarla. El motivo de la decisión es obligatorio.</p>}
        <p>Usa sólo información del documento. Marca «Sin respuesta en el documento» cuando, después de buscar y revisar las secciones pertinentes, la información no esté disponible; en ese caso no añadas una respuesta ni evidencia inventadas.</p>
      </section>}
      {evaluation && <section>
        <h3>{kind === 'adjudicate' ? 'Adjudicación de valoraciones' : 'Criterios de evaluación'}</h3>
        {kind === 'adjudicate' && <p>Revisa ambas valoraciones. «Usar esta versión» copia una propuesta; comprueba todos sus campos y escribe el motivo de tu decisión.</p>}
        <p>Lee la pregunta, abre la referencia y comprueba el documento. Evalúa el contenido sin intentar identificar el método ni exigir las mismas palabras que la referencia.</p>
        <dl>
          <dt>Corrección</dt><dd>Correcta (2): responde por completo y sin errores. Parcial (1): contiene información correcta, pero le falta algo o tiene errores parciales. Incorrecta (0): falla en lo esencial.</dd>
          <dt>Respaldo</dt><dd>Indica si hay afirmaciones que el documento no sostiene. Usa «No puedo determinarlo» si no puedes comprobarlo.</dd>
          <dt>Citas</dt><dd>Abre sus fuentes y comprueba si respaldan toda la respuesta, sólo una parte o ninguna. Si no hay citas, usa «No aplica» y valora el respaldo por separado.</dd>
          <dt>Abstención</dt><dd>Si no responde, indica si está justificado porque falta información o si debió responder. Si responde, usa «No aplica».</dd>
        </dl>
        <p>Si una pregunta ambigua, un documento incompleto o una referencia defectuosa impiden evaluar, elige «Sin valoración» y describe la incidencia. No marques «Incorrecta» sólo por un problema del material.</p>
      </section>}
      <section>
        <h3>{evaluation ? 'Cómo leer la evidencia' : 'Evidencia mínima suficiente'}</h3>
        <p>Cada conjunto debe justificar la respuesta completa por sí solo. Dentro de un conjunto, los fragmentos se usan juntos; otro conjunto representa una alternativa suficiente.</p>
        <div className="guide-example"><strong>Ejemplo inventado · una biblioteca</strong><p>Pregunta: ¿A qué hora abre la sala y quién puede entrar?</p><ul><li>A: «La sala abre a las nueve».</li><li>B: «Pueden entrar socios y visitantes».</li><li>C: «Socios y visitantes pueden entrar desde las nueve».</li></ul><p>Conjunto 1: A + B, porque se necesitan ambos. Conjunto 2: C, porque basta por sí solo.</p></div>
        {!evaluation && <p>Selecciona sólo lo necesario, con contexto suficiente para entenderlo. Si dos pasajes se necesitan juntos, añádelos al mismo conjunto activo; no crees un conjunto separado por cada párrafo.</p>}
      </section>
      <section>
        <h3>Documento y formulario</h3>
        <p>En móvil, alterna «Documento» y «{evaluation ? 'Evaluación' : 'Anotación'}»; cada vista conserva su posición. Usa la búsqueda o el selector de secciones para localizar pasajes.</p>
        {evaluation ? <p>Abre las citas o la evidencia de referencia y pulsa «Ver origen» o «Ver en el documento» para comprobar el contexto.</p> : <p>Selecciona texto y pulsa «Añadir selección». También puedes abrir «Seleccionar evidencia con teclado», elegir el párrafo y sus palabras inicial y final, y pulsar «Añadir evidencia». El texto se añade al conjunto activo.</p>}
      </section>
    </div></details>
    <details><summary>Guardar y retomar</summary><div className="task-guide-content save-guide">
      <p>El borrador se guarda automáticamente. Espera «Guardado» o usa «Guardar y salir» para volver a Mis tareas; después abre la misma tarea para continuar.</p>
      <p>Sin conexión, los cambios se conservan en este navegador hasta reconectar. No cierres ni borres los datos del navegador antes de sincronizar. Si falla el guardado, la tarea permanece abierta y puedes reintentar o descargar el borrador.</p>
      <p>{singleAuthor ? '«Enviar» fija tu autoría y deja pendiente la revisión personal. Después puedes volver a abrir la tarea y pulsar «Confirmar revisión» cuando la hayas comprobado. No uses «Enviar» para pausar un borrador.' : '«Enviar» fija tu versión para continuar el proceso; no lo uses para pausar. Una revisión independiente aún requiere aceptar la anotación o enviar el desacuerdo después de comparar.'}</p>
    </div></details>
  </section>;
}
