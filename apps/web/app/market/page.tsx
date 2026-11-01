import { MarketPanel } from './market-panel';
import { IbkrConnectionPanel } from './ibkr-connection';
export default function MarketPage() {
  return (
    <>
      <div className="page-heading">
        <h1>Market</h1>
        <p className="intro">
          Prices, source evidence, and portfolio valuation.
        </p>
      </div>
      <MarketPanel />
      <IbkrConnectionPanel />
    </>
  );
}
