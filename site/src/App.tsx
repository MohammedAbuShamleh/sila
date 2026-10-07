import SiteFooter from './components/SiteFooter'
import SiteHeader from './components/SiteHeader'
import Guarantees from './sections/Guarantees'
import Hero from './sections/Hero'
import HowItWorks from './sections/HowItWorks'
import Limits from './sections/Limits'
import Numbers from './sections/Numbers'
import WorksWith from './sections/WorksWith'

export default function App() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <HowItWorks />
        <Guarantees />
        <Numbers />
        <Limits />
        <WorksWith />
      </main>
      <SiteFooter />
    </>
  )
}
