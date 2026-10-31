import { MarketPanel } from './market-panel';
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
    </>
  );
}
