'use client';
// P0-3: same-question comparison, deliberately narrow. Only attempts that
// answer the SAME question (same questionId, or the same legacy field/day) are
// compared. Pronunciation never appears; no row says "improved" or "worse".
import {splitSameQuestion,type CompareSide,type QuestionRef} from './speaking-compare';

const STATUS_LABEL:Record<string,string>={calibrated:'已校准证据',reference:'参考估计',suggestive:'建议性',asr:'ASR',unavailable:'不可用'};

export default function AttemptCompare({left,right,leftRef,rightRef,labelLeft='上次',labelRight='这次'}:{
  left:CompareSide;right:CompareSide;leftRef:QuestionRef;rightRef:QuestionRef;labelLeft?:string;labelRight?:string;
}) {
  const result=splitSameQuestion({left:leftRef,right:rightRef,leftSide:left,rightSide:right});
  if(!result.matched&&!result.rows.length)
    return <section className="ss-compare" aria-label="同题对比">
      <h4>同题两次作答对比</h4>
      <p className="af-hint" role="status">{result.reason}</p>
    </section>;
  return <section className="ss-compare" aria-label="同题对比">
    <h4>同题两次作答对比 · 只列数值与状态</h4>
    {!result.rows.length
      ?<p className="af-hint">两次作答都还没有可对比的指标。</p>
      :<div className="ss-compare-scroll"><table>
        <caption>{labelLeft} 与 {labelRight} 的同一道题</caption>
        <thead><tr><th scope="col">指标</th><th scope="col">{labelLeft}</th><th scope="col">{labelRight}</th><th scope="col">变化</th><th scope="col">状态</th></tr></thead>
        <tbody>{result.rows.map(row=><tr key={row.key}>
          <th scope="row">{row.label_zh}</th>
          <td>{row.left}</td>
          <td>{row.right}</td>
          <td>{row.delta??'—'}</td>
          <td><span className="ss-compare-status">{STATUS_LABEL[row.status]??row.status}</span>
            {row.note&&<small>{row.note}</small>}</td>
        </tr>)}</tbody>
      </table></div>}
    <p className="af-hint">{result.disclosure}这里没有“进步/退步”的判断，只有数值和你自己确认过的状态。</p>
  </section>;
}
